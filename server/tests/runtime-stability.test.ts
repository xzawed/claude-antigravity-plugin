import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAgAuth, PendingAuthSessionManager } from '../src/auth.js';
import {
  archiveManifest,
  assertSafeTaskId,
  ensureBridgeDirs,
  getManifestPath,
  readArchivedManifest,
  readManifest,
  writeManifest,
} from '../src/bridge-fs.js';
import { handleAgCliAdmin } from '../src/cli-admin.js';
import { detectEnvironment, findBinaryInPath } from '../src/detector.js';
import { ApiWorkerEngine } from '../src/engines/api-worker.js';
import { attachStreamJsonHeartbeat, SubscriptionEngine } from '../src/engines/subscription.js';
import { BackgroundJobManager, handleGetAgJob } from '../src/jobs.js';
import { handleAgSession, PersistentSessionManager } from '../src/sessions.js';
import { AgPluginError, BridgeManifest, DEFAULT_BRIDGE_CONFIG } from '../src/types.js';

function createMockChild(options: { epipeOnWrite?: boolean } = {}): ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  emitClose: (code: number | null) => void;
} {
  const ee = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    emitClose: (code: number | null) => void;
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      if (options.epipeOnWrite) {
        const err = new Error('write EPIPE') as NodeJS.ErrnoException;
        err.code = 'EPIPE';
        this.emit('error', err);
        cb(err);
        return;
      }
      cb();
    },
  });
  Object.assign(ee, {
    pid: 999999,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin,
    stdout,
    stderr,
    kill: () => {
      ee.exitCode = 1;
      return true;
    },
    emitClose: (code: number | null) => {
      (ee as { exitCode: number | null }).exitCode = code;
      ee.emit('close', code);
    },
  });
  return ee;
}

describe('v1.6.1 runtime stability, engines & detector fixes (TC-U49 ~ TC-U53)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('TC-U49: sessions and auth survive stdin EPIPE cleanly, enforce workspaceRoot, skip closed auth sessions, and finalize session checkpoint manifests', async () => {
    // 1. Session EPIPE on stdin rejects turn cleanly without crashing the process
    const sessMgr = new PersistentSessionManager();
    const epipeChild = createMockChild({ epipeOnWrite: true });
    const session = sessMgr.create(tmpRoot, 'linux', epipeChild, 'deadbeef'.repeat(5), 'ag-sess-cp-1');

    archiveManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-sess-cp-1',
      title: 'Persistent session checkpoint',
      mode: 'subscription',
      status: 'RUNNING',
      lockedPaths: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: [],
    });

    await expect(sessMgr.sendTurn(session, 'hello', 5)).rejects.toThrow(/EPIPE/);

    // 2. Explicit sessionId with mismatched workspaceRoot returns undefined
    const otherWs = path.join(tmpRoot, 'other-workspace');
    expect(sessMgr.get(session.sessionId, otherWs)).toBeUndefined();
    expect(sessMgr.get(session.sessionId, tmpRoot)).toBe(session);

    // 3. Closing session finalizes archived checkpoint manifest to VERIFIED
    epipeChild.exitCode = 0;
    const closeRes = await handleAgSession(
      { action: 'close', sessionId: session.sessionId, workspaceRoot: tmpRoot },
      { sessionManager: sessMgr },
    );
    expect(closeRes.ok).toBe(true);
    expect(readArchivedManifest(tmpRoot, 'ag-sess-cp-1')?.status).toBe('VERIFIED');

    // 4. Auth PendingAuthSessionManager skips closed sessions when sessionId omitted, and EPIPE on complete returns AUTH_LOGIN_FAILED
    const authMgr = new PendingAuthSessionManager();
    const deadAuthChild = createMockChild();
    const s1 = authMgr.register(tmpRoot, '/usr/bin/agy', 'linux', deadAuthChild, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1');
    deadAuthChild.emitClose(1);

    const liveAuthChild = createMockChild({ epipeOnWrite: true });
    const s2 = authMgr.register(tmpRoot, '/usr/bin/agy', 'linux', liveAuthChild, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=2');
    expect(authMgr.get(undefined)?.sessionId).toBe(s2.sessionId);
    expect(s1.closed).toBe(true);

    const completeRes = await handleAgAuth(
      { action: 'complete', code: '4/0AbcSecretCode123456', sessionId: s2.sessionId, workspaceRoot: tmpRoot },
      { sessionManager: authMgr },
    );
    expect(completeRes.ok).toBe(false);
    expect(completeRes.errorCode).toBe('AUTH_LOGIN_FAILED');
    expect(completeRes.errorMessage).not.toContain('4/0AbcSecretCode123456');
  });

  it('TC-U50: SubscriptionEngine fails fast on early CLI exit, survives corrupt manifest on abort, and masks stream error secrets', async () => {
    const fakeSecret = ['AIza', 'SyStreamErrorLeak1234567890abcdef'].join('');
    const taskId = 'ag-sub-fast-1';
    const manifest: BridgeManifest = {
      schemaVersion: 1,
      taskId,
      title: 'Early exit test',
      mode: 'subscription',
      status: 'DISPATCHED',
      lockedPaths: ['src/'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: [],
    };
    writeManifest(tmpRoot, manifest);

    // 1. Early process exit fails fast (< 3s) instead of waiting timeoutSec=30
    const startMs = Date.now();
    const engine = new SubscriptionEngine({
      triggerFn: async () => ({
        methodUsed: 'cli',
        processExitPromise: Promise.resolve(2),
      }),
    });
    const res = await engine.execute({
      workspaceRoot: tmpRoot,
      pluginRoot: path.resolve(import.meta.dirname, '..', '..'),
      manifest,
      config: { ...DEFAULT_BRIDGE_CONFIG, subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, timeout_sec: 30 } },
      instructions: 'Do work',
      acceptanceCriteria: ['Done'],
      detection: {
        configuredMode: 'subscription',
        resolvedMode: 'subscription',
        platform: 'linux',
        subscription: { detected: true, cliBinary: 'agy', cliPath: '/usr/bin/agy', triggerMethod: 'cli_only' },
        api: { configured: false, source: 'none', envVarName: 'GEMINI_API_KEY', model: 'gemini-2.5-pro', maxTurns: 5 },
        recommendations: [],
      },
    });
    expect(res.status).toBe('FAILED');
    expect(res.errorMessage).toContain('exited (code 2)');
    expect(Date.now() - startMs).toBeLessThan(3000);

    // 2. Corrupt manifest.json during abort does not throw unhandled JSON syntax error
    ensureBridgeDirs(tmpRoot);
    fs.writeFileSync(getManifestPath(tmpRoot), '{broken-json', 'utf8');
    const ac = new AbortController();
    ac.abort();
    const engine2 = new SubscriptionEngine({
      triggerFn: async () => ({ methodUsed: 'custom' }),
    });
    const cancelRes = await engine2.execute({
      workspaceRoot: tmpRoot,
      pluginRoot: path.resolve(import.meta.dirname, '..', '..'),
      manifest,
      config: DEFAULT_BRIDGE_CONFIG,
      instructions: 'Do work',
      acceptanceCriteria: ['Done'],
      abortSignal: ac.signal,
      detection: {
        configuredMode: 'subscription',
        resolvedMode: 'subscription',
        platform: 'linux',
        subscription: { detected: true, cliBinary: 'agy', cliPath: '/usr/bin/agy', triggerMethod: 'cli_only' },
        api: { configured: false, source: 'none', envVarName: 'GEMINI_API_KEY', model: 'gemini-2.5-pro', maxTurns: 5 },
        recommendations: [],
      },
    });
    expect(cancelRes.errorCode).toBe('TASK_CANCELLED');

    // 3. Stream result error is masked before writing to manifest.json
    writeManifest(tmpRoot, manifest);
    const stream = new PassThrough();
    const hb = attachStreamJsonHeartbeat(stream, {
      workspaceRoot: tmpRoot,
      taskId,
      autoFinalizeOnResult: true,
    });
    stream.write(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR', error: `Upstream key=${fakeSecret}` },
      }) + '\n',
    );
    stream.end();
    await new Promise((r) => setTimeout(r, 20));
    hb.stop();
    const updated = readManifest(tmpRoot);
    expect(updated?.status).toBe('FAILED');
    expect(updated?.error).toContain('[REDACTED]');
    expect(updated?.error).not.toContain(fakeSecret);
  });

  it('TC-U51: ApiWorkerEngine forwards abortSignal, emits strictly monotonic progress, and caps read_file size', async () => {
    // Create a >2MB file to test read_file size cap
    fs.writeFileSync(path.join(tmpRoot, 'huge.txt'), 'a'.repeat(2 * 1024 * 1024 + 128), 'utf8');

    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyMockWorkerKey1234567890abcdef';
    try {
      let sawAbortSignal = false;
      let turn = 0;
      const progressEvents: Array<{ progress: number; total?: number }> = [];
      const ac = new AbortController();

      const engine = new ApiWorkerEngine({
        retryBaseDelayMs: 1,
        adapterFactory: () => ({
          generateTurn: async ({ abortSignal }) => {
            if (abortSignal) sawAbortSignal = true;
            turn += 1;
            if (turn === 1) {
              return { functionCalls: [{ name: 'read_file', args: { path: 'huge.txt' } }] };
            }
            return { text: 'Checked huge file safely.' };
          },
        }),
      });

      const manifest: BridgeManifest = {
        schemaVersion: 1,
        taskId: 'ag-api-mono-1',
        title: 'API worker safety test',
        mode: 'api',
        status: 'DISPATCHED',
        lockedPaths: ['src/'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      };
      writeManifest(tmpRoot, manifest);

      const res = await engine.execute({
        workspaceRoot: tmpRoot,
        pluginRoot: path.resolve(import.meta.dirname, '..', '..'),
        manifest,
        config: { ...DEFAULT_BRIDGE_CONFIG, api: { ...DEFAULT_BRIDGE_CONFIG.api, max_turns: 4 } },
        instructions: 'Read huge.txt',
        acceptanceCriteria: ['Done'],
        abortSignal: ac.signal,
        onProgress: (ev) => progressEvents.push({ progress: ev.progress, total: ev.total }),
        detection: {
          configuredMode: 'api',
          resolvedMode: 'api',
          platform: 'linux',
          subscription: { detected: false, triggerMethod: 'cli_or_ipc' },
          api: { configured: true, source: 'env', envVarName: 'GEMINI_API_KEY', model: 'gemini-2.5-pro', maxTurns: 4 },
          recommendations: [],
        },
      });

      expect(res.status).toBe('VERIFIED');
      expect(sawAbortSignal).toBe(true);
      expect(progressEvents.length).toBe(4);
      // Progress values must be strictly increasing (0, 1, 2, 8)
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i].progress).toBeGreaterThan(progressEvents[i - 1].progress);
      }
      expect(progressEvents[0].total).toBe(8);
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('TC-U52: detector prefers standard-installed agy over legacy ag in PATH, handles .app directories, warns on missing app_path, and skips directories in PATH', () => {
    const agyStdPath = '/home/dev/.gemini/antigravity-cli/bin/agy';
    const envWithBoth = detectEnvironment(DEFAULT_BRIDGE_CONFIG, undefined, {
      platform: 'linux',
      env: {},
      homedir: '/home/dev',
      existsSync: (p) => p === agyStdPath,
      // Legacy `ag` (Silver Searcher) is in PATH, while `agy` is in standard install path
      findBinary: (name) => (name === 'ag' ? '/usr/bin/ag' : undefined),
    });
    expect(envWithBoth.subscription.detected).toBe(true);
    expect(envWithBoth.subscription.cliBinary).toBe('agy');
    expect(envWithBoth.subscription.cliPath).toBe(agyStdPath);

    // Explicit macOS .app path must not be treated as a CLI executable
    const macAppEnv = detectEnvironment(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, app_path: '/Applications/Antigravity.app' },
      },
      undefined,
      {
        platform: 'darwin',
        env: {},
        homedir: '/Users/dev',
        existsSync: (p) => p === '/Applications/Antigravity.app',
        findBinary: () => undefined,
      },
    );
    expect(macAppEnv.subscription.detected).toBe(true);
    expect(macAppEnv.subscription.appPath).toBe('/Applications/Antigravity.app');
    expect(macAppEnv.subscription.cliPath).toBeUndefined();

    // Missing explicit app_path emits recommendation
    const missingAppEnv = detectEnvironment(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, app_path: '/nonexistent/bin/agy' },
      },
      undefined,
      {
        platform: 'linux',
        env: {},
        homedir: '/home/dev',
        existsSync: () => false,
        findBinary: () => undefined,
      },
    );
    expect(missingAppEnv.recommendations.some((r) => r.includes('/nonexistent/bin/agy'))).toBe(true);

    // Directory named `agy` (or `agy.exe`) in PATH is ignored by real-FS findBinaryInPath
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(path.join(fakeBinDir, process.platform === 'win32' ? 'agy.exe' : 'agy'), {
      recursive: true,
    });
    const found = findBinaryInPath('agy', process.platform, {
      PATH: fakeBinDir,
      PATHEXT: '.EXE',
    });
    expect(found).toBeUndefined();
  });

  it('TC-U53: cli-admin handles null .mcp.json entries & masks custom secrets, jobs marks IDLE disk records inactive, and assertSafeTaskId blocks dots/.lock/reserved names', async () => {
    // 1. assertSafeTaskId hardening
    for (const bad of ['.hidden', 'trailing.', 'foo.lock', 'CON', 'nul.txt', 'COM1', 'LPT9']) {
      expect(() => assertSafeTaskId(bad), bad).toThrow(AgPluginError);
    }
    expect(assertSafeTaskId('ag-2026-valid_1.0')).toBe('ag-2026-valid_1.0');

    // 2. cli-admin null .mcp.json entry + command+url priority + custom secret masking
    const customToken = 'my-custom-opaque-secret-998877';
    fs.writeFileSync(
      path.join(tmpRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          brokenNull: null,
          dualServer: {
            command: 'node',
            args: ['server.js'],
            url: 'https://ignored-when-command-set.example.com',
            env: { MY_TOKEN: customToken },
          },
        },
      }),
      'utf8',
    );
    const seenCalls: string[][] = [];
    const syncRes = await handleAgCliAdmin(
      { action: 'mcp_sync_from_claude', dryRun: false, workspaceRoot: tmpRoot },
      {
        detectorDeps: {
          platform: 'linux',
          env: {},
          homedir: '/home/dev',
          existsSync: (p) => p === '/usr/local/bin/agy',
          findBinary: (b) => (b === 'agy' ? '/usr/local/bin/agy' : undefined),
        },
        runCliFn: async (_cli, args) => {
          seenCalls.push(args);
          return { exitCode: 0, stdout: `Registered with ${customToken}`, stderr: '' };
        },
      },
    );
    expect(syncRes.ok).toBe(true);
    expect(syncRes.syncedServers?.find((s) => s.name === 'brokenNull')?.status).toBe('skipped');
    expect(seenCalls[0]).toContain('stdio');
    expect(syncRes.output).not.toContain(customToken);
    expect(syncRes.output).toContain('[REDACTED]');

    // 3. jobs disk fallback never marks IDLE or orphaned disk manifests as active: true
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-idle-disk',
      title: 'Rolled back task',
      mode: 'subscription',
      status: 'IDLE',
      lockedPaths: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: [],
    });
    const mgr = new BackgroundJobManager();
    const jobRes = await handleGetAgJob(
      { jobId: 'ag-idle-disk', workspaceRoot: tmpRoot },
      { jobManager: mgr },
    );
    expect(jobRes.ok).toBe(true);
    expect(jobRes.job?.active).toBe(false);
    expect(jobRes.job?.status).not.toBe('RUNNING');
  });
});
