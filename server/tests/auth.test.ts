import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractOAuthUrl,
  handleAgAuth,
  isHeadlessOrSshEnv,
  PendingAuthSessionManager,
  readAgySettingsAuthHints,
} from '../src/auth.js';
import { DetectorDeps } from '../src/detector.js';

interface FakeChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

function createFakeChild(): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit('close', null);
    return true;
  };
  return proc;
}

function makeAgyDetectorDeps(env: NodeJS.ProcessEnv = {}): DetectorDeps {
  return {
    platform: 'linux',
    env,
    existsSync: (p) => p === '/usr/local/bin/agy',
    findBinary: (bin) => (bin === 'agy' ? '/usr/local/bin/agy' : undefined),
    homedir: '/tmp/nonexistent-home',
  };
}

describe('ag_auth & /ag-login flows (TC-U17 ~ TC-U21)', () => {
  let tmpRoot: string;
  let tmpHome: string;
  let manager: PendingAuthSessionManager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-auth-test-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-auth-home-'));
    manager = new PendingAuthSessionManager(60_000);
  });

  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('TC-U17: extracts Google OAuth URL, detects SSH/headless env, and reads settings.json auth hints', () => {
    const sample = `Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123&state=abc\n\nThen paste the authorization code:`;
    expect(extractOAuthUrl(sample)).toBe(
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123&state=abc',
    );
    expect(extractOAuthUrl('no url here')).toBeUndefined();

    expect(isHeadlessOrSshEnv({ SSH_CONNECTION: '1 2 3 4' }, 'win32')).toBe(true);
    expect(isHeadlessOrSshEnv({ CI: 'true' }, 'darwin')).toBe(true);
    expect(isHeadlessOrSshEnv({}, 'linux')).toBe(true);
    expect(isHeadlessOrSshEnv({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadlessOrSshEnv({}, 'win32')).toBe(false);

    const cliDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, 'settings.json'),
      JSON.stringify({ modelProvider: 'gemini', gcp: { project: 'demo-proj' } }),
      'utf8',
    );
    expect(readAgySettingsAuthHints(tmpHome)).toEqual({
      modelProvider: 'gemini',
      hasGcpConfig: true,
    });
  });

  it('TC-U18: reports AUTHENTICATED, UNAUTHENTICATED, and CLI_NOT_INSTALLED cleanly on action=status', async () => {
    // 1. Authenticated via live agy models
    const authRes = await handleAgAuth(
      { action: 'status', workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        queryCapabilitiesFn: async () => ({
          models: [
            { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
            { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
          ],
          agents: [],
          warnings: [],
        }),
      },
    );
    expect(authRes.ok).toBe(true);
    expect(authRes.status).toBe('AUTHENTICATED');
    expect(authRes.authenticated).toBe(true);
    expect(authRes.authMethod).toBe('google-oauth');
    expect(authRes.modelCount).toBe(2);

    // 2. Unauthenticated when agy models returns 0 models
    const unauthRes = await handleAgAuth(
      { action: 'status', workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        queryCapabilitiesFn: async () => ({
          models: [],
          agents: [],
          warnings: ['Authentication required'],
        }),
      },
    );
    expect(unauthRes.ok).toBe(true);
    expect(unauthRes.status).toBe('UNAUTHENTICATED');
    expect(unauthRes.authenticated).toBe(false);

    // 3. CLI not installed and no API key
    const missingRes = await handleAgAuth(
      { action: 'status', workspaceRoot: tmpRoot },
      {
        detectorDeps: {
          platform: 'linux',
          env: {},
          existsSync: () => false,
          findBinary: () => undefined,
          homedir: tmpHome,
        },
        homeDir: tmpHome,
      },
    );
    expect(missingRes.ok).toBe(false);
    expect(missingRes.status).toBe('CLI_NOT_INSTALLED');
    expect(missingRes.errorCode).toBe('AGY_CLI_NOT_FOUND');
  });

  it('TC-U19: short-circuits login when already authenticated, and runs browser login with --force', async () => {
    let spawned = false;
    const already = await handleAgAuth(
      { action: 'login', workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        sessionManager: manager,
        queryCapabilitiesFn: async () => ({
          models: [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon' }],
          agents: [],
          warnings: [],
        }),
        spawnFn: () => {
          spawned = true;
          return createFakeChild() as unknown as ChildProcess;
        },
      },
    );
    expect(already.ok).toBe(true);
    expect(already.status).toBe('AUTHENTICATED');
    expect(spawned).toBe(false);

    // Force browser login -> spawns `agy acp --login`, exits 0 -> verified AUTHENTICATED
    let capturedArgs: string[] = [];
    const forced = await handleAgAuth(
      { action: 'login', flow: 'browser', force: true, workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        sessionManager: manager,
        queryCapabilitiesFn: async () => ({
          models: [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon' }],
          agents: [],
          warnings: [],
        }),
        spawnFn: (_cmd, args) => {
          capturedArgs = args;
          const child = createFakeChild();
          setTimeout(() => {
            child.stdout.write('Signed in successfully.\n');
            child.emit('close', 0);
          }, 20);
          return child as unknown as ChildProcess;
        },
      },
    );
    expect(capturedArgs).toEqual(['acp', '--login']);
    expect(forced.ok).toBe(true);
    expect(forced.status).toBe('AUTHENTICATED');
    expect(forced.modelCount).toBe(1);
  });

  it('TC-U20: runs manual link+code OAuth flow (AWAITING_CODE -> complete -> AUTHENTICATED) and supports cancel', async () => {
    let receivedStdin = '';
    const manualChild = createFakeChild();
    manualChild.stdin.on('data', (chunk) => {
      receivedStdin += chunk.toString('utf8');
      if (receivedStdin.includes('4/0mock-auth-code')) {
        manualChild.stdout.write('Authentication complete.\n');
        manualChild.emit('close', 0);
      }
    });

    let capCalls = 0;
    const startPromise = handleAgAuth(
      { action: 'login', flow: 'manual', force: true, workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        sessionManager: manager,
        queryCapabilitiesFn: async () => {
          capCalls += 1;
          return {
            models: [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon' }],
            agents: [],
            warnings: [],
          };
        },
        spawnFn: (_cmd, args, opts) => {
          expect(args).toEqual(['acp', '--login']);
          expect(opts.env.SSH_CONNECTION).toBeTruthy();
          setTimeout(() => {
            manualChild.stdout.write(
              'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz\n\nThen paste the authorization code:\n',
            );
          }, 15);
          return manualChild as unknown as ChildProcess;
        },
      },
    );

    const awaiting = await startPromise;
    expect(awaiting.ok).toBe(true);
    expect(awaiting.status).toBe('AWAITING_CODE');
    expect(awaiting.authUrl).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz',
    );
    expect(awaiting.sessionId).toMatch(/^ag-auth-/);
    expect(manager.size()).toBe(1);

    const completed = await handleAgAuth(
      {
        action: 'complete',
        sessionId: awaiting.sessionId,
        code: '4/0mock-auth-code',
        workspaceRoot: tmpRoot,
      },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        sessionManager: manager,
        queryCapabilitiesFn: async () => {
          capCalls += 1;
          return {
            models: [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon' }],
            agents: [],
            warnings: [],
          };
        },
      },
    );
    expect(completed.ok).toBe(true);
    expect(completed.status).toBe('AUTHENTICATED');
    expect(completed.modelCount).toBe(1);
    expect(receivedStdin.trim()).toBe('4/0mock-auth-code');
    expect(manager.size()).toBe(0);
    // Ensure startManualLoginFlow removed its close listener so complete only verifies once
    await new Promise((r) => setTimeout(r, 20));
    expect(capCalls).toBe(1);

    // Cancel flow kills pending child cleanly
    const cancelChild = createFakeChild();
    const awaiting2 = await handleAgAuth(
      { action: 'login', flow: 'manual', force: true, workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ DISPLAY: ':0' }),
        homeDir: tmpHome,
        sessionManager: manager,
        spawnFn: () => {
          setTimeout(() => {
            cancelChild.stdout.write(
              'https://accounts.google.com/o/oauth2/auth?client_id=cancel\n',
            );
          }, 10);
          return cancelChild as unknown as ChildProcess;
        },
      },
    );
    expect(awaiting2.status).toBe('AWAITING_CODE');
    const cancelled = await handleAgAuth(
      { action: 'cancel', sessionId: awaiting2.sessionId, workspaceRoot: tmpRoot },
      { sessionManager: manager },
    );
    expect(cancelled.ok).toBe(true);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelChild.killed).toBe(true);
    expect(manager.size()).toBe(0);
  });

  it('TC-U21: returns safe logout guidance without mutating OS keyring', async () => {
    const res = await handleAgAuth(
      { action: 'logout', workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps({ AGY_ADC_AUTH: 'true' }),
        homeDir: tmpHome,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('LOGOUT_INSTRUCTIONS');
    expect(res.nextSteps.some((s) => s.includes('/logout'))).toBe(true);
    expect(res.nextSteps.some((s) => s.includes('AGY_ADC_AUTH'))).toBe(true);
  });
});
