import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, maskSecrets } from '../src/config.js';
import {
  assertResolvedMode,
  detectEnvironment,
  DetectorDeps,
  findBinaryInPath,
} from '../src/detector.js';
import { AgPluginError, DEFAULT_BRIDGE_CONFIG } from '../src/types.js';

const FAKE_PREFIX = 'AIza';
const fakeGoogleKey = (suffix: string): string => `${FAKE_PREFIX}${suffix}`;

function makeDeps(overrides: Partial<DetectorDeps> = {}): DetectorDeps {
  return {
    platform: 'linux',
    env: {},
    homedir: '/home/tester',
    existsSync: () => false,
    findBinary: () => undefined,
    ...overrides,
  };
}

describe('detector & config (TC-U01 ~ TC-U03, TC-S05)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-U01: prioritizes subscription mode when both agy CLI and GEMINI_API_KEY are present', () => {
    const deps = makeDeps({
      platform: 'win32',
      env: { GEMINI_API_KEY: fakeGoogleKey('SyDummySecretKey1234567890abcd') },
      findBinary: (name) => (name === 'agy' ? 'C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe' : undefined),
    });

    const res = detectEnvironment(DEFAULT_BRIDGE_CONFIG, undefined, deps);
    expect(res.resolvedMode).toBe('subscription');
    expect(res.subscription.detected).toBe(true);
    expect(res.subscription.cliBinary).toBe('agy');
    expect(res.api.configured).toBe(true);
    expect(assertResolvedMode(res)).toBe('subscription');
  });

  it('detects agy from standard install location even when MCP host strips PATH', () => {
    const winAgy = path.join('C:\\Users\\tester', 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const deps = makeDeps({
      platform: 'win32',
      homedir: 'C:\\Users\\tester',
      env: {},
      findBinary: () => undefined,
      existsSync: (p) => p === winAgy,
    });

    const res = detectEnvironment(DEFAULT_BRIDGE_CONFIG, undefined, deps);
    expect(res.resolvedMode).toBe('subscription');
    expect(res.subscription.cliBinary).toBe('agy');
    expect(res.subscription.cliPath).toBe(winAgy);
  });

  it('findBinaryInPath resolves mixed-case Windows Path and PATHEXT without spawning subprocesses', () => {
    const winBin = path.win32.join('C:\\CustomBin', 'agy.exe');
    const foundWin = findBinaryInPath(
      'agy',
      'win32',
      { Path: 'C:\\Other;C:\\CustomBin', PATHEXT: '.EXE;.CMD' },
      (p) => p === winBin,
    );
    expect(foundWin).toBe(winBin);

    const posixBin = path.posix.join('/usr/local/bin', 'agy');
    const foundPosix = findBinaryInPath(
      'agy',
      'linux',
      { PATH: '/bin:/usr/local/bin' },
      (p) => p === posixBin,
    );
    expect(foundPosix).toBe(posixBin);
  });

  it('TC-S13: findBinaryInPath ignores relative PATH entries, so an agy the workspace ships is never detected', () => {
    // "." and "bin" resolve against the cwd — the opened repository. Each holds a planted agy here.
    const plantedWin = new Set(['agy.exe', 'bin\\agy.exe', 'C:\\Tools\\agy.exe']);
    expect(
      findBinaryInPath('agy', 'win32', { Path: '.;bin;C:\\Tools', PATHEXT: '.EXE;.CMD' }, (p) =>
        plantedWin.has(p),
      ),
    ).toBe('C:\\Tools\\agy.exe');

    const plantedPosix = new Set(['agy', 'bin/agy', '/usr/local/bin/agy']);
    expect(
      findBinaryInPath('agy', 'linux', { PATH: '.:bin:/usr/local/bin' }, (p) => plantedPosix.has(p)),
    ).toBe('/usr/local/bin/agy');
  });

  it('TC-U13: infers cliBinary when subscription.app_path explicitly overrides agy or antigravity', () => {
    const customAgy = 'C:\\CustomTools\\agy.exe';
    const agyRes = detectEnvironment(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, app_path: customAgy },
      },
      undefined,
      makeDeps({
        platform: 'win32',
        existsSync: (p) => p === customAgy,
      }),
    );
    expect(agyRes.resolvedMode).toBe('subscription');
    expect(agyRes.subscription.cliBinary).toBe('agy');
    expect(agyRes.subscription.cliPath).toBe(customAgy);

    const customLegacy = '/opt/bin/antigravity';
    const legacyRes = detectEnvironment(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription, app_path: customLegacy },
      },
      undefined,
      makeDeps({
        platform: 'linux',
        existsSync: (p) => p === customLegacy,
      }),
    );
    expect(legacyRes.subscription.cliBinary).toBe('antigravity');
  });

  it('TC-U02: falls back to api mode when subscription app/CLI is absent but GEMINI_API_KEY is set', () => {
    const deps = makeDeps({
      platform: 'darwin',
      env: { GEMINI_API_KEY: fakeGoogleKey('SyFallbackKey1234567890abcdefg') },
    });

    const res = detectEnvironment(DEFAULT_BRIDGE_CONFIG, undefined, deps);
    expect(res.resolvedMode).toBe('api');
    expect(res.subscription.detected).toBe(false);
    expect(res.api.configured).toBe(true);
    expect(res.api.source).toBe('env');
    expect(assertResolvedMode(res)).toBe('api');
  });

  it('TC-U03: returns unavailable and throws NO_ANTIGRAVITY_PROVIDER when neither provider exists', () => {
    const deps = makeDeps();
    const res = detectEnvironment(DEFAULT_BRIDGE_CONFIG, undefined, deps);
    expect(res.resolvedMode).toBe('unavailable');
    expect(res.recommendations.length).toBeGreaterThan(0);

    try {
      assertResolvedMode(res);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgPluginError);
      expect((err as AgPluginError).code).toBe('NO_ANTIGRAVITY_PROVIDER');
    }
  });

  it('TC-S05: masks GEMINI_API_KEY and AIza patterns in outputs and never exposes keys in detection output', () => {
    const dummyKey = fakeGoogleKey('SyDummySecretKey1234567890abcd');
    const backupKey = fakeGoogleKey('SyAnotherSecretKey999999999999');
    const raw = `Error calling Gemini with key ${dummyKey} and backup ${backupKey}`;
    const masked = maskSecrets(raw, [], { GEMINI_API_KEY: dummyKey });
    expect(masked).not.toContain(dummyKey);
    expect(masked).not.toContain(backupKey);
    expect(masked).toContain('[REDACTED]');

    const det = detectEnvironment(
      DEFAULT_BRIDGE_CONFIG,
      undefined,
      makeDeps({ env: { GEMINI_API_KEY: dummyKey } }),
    );
    expect(JSON.stringify(det)).not.toContain(dummyKey);
  });

  it('TC-S07: redacts OAuth access tokens, auth codes, sk-/ghp_ keys, and Bearer headers', () => {
    const oauthToken = ['ya29.', 'a0AfH6SMDummyAccessTokenValue123456'].join('');
    const authCode = ['4/0A', 'DummyOAuthAuthorizationCode123456789'].join('');
    const skKey = ['sk-', 'ant-DummySecretKeyValue1234567890abcd'].join('');
    const ghToken = ['ghp_', 'DummyGitHubPersonalAccessToken12345'].join('');
    const bearer = ['Bearer ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join('');

    const masked = maskSecrets(
      `oauth=${oauthToken} code=${authCode} sk=${skKey} gh=${ghToken} auth="${bearer}"`,
    );
    expect(masked).not.toContain(oauthToken);
    expect(masked).not.toContain(authCode);
    expect(masked).not.toContain(skKey);
    expect(masked).not.toContain(ghToken);
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiIs');
    expect(masked).toContain('Bearer [REDACTED]');
  });

  it('applies config precedence: config.json > env > defaults', () => {
    const fromEnv = loadConfig(tmpRoot, { AG_DEFAULT_MODE: 'api', AG_MODEL: 'gemini-2.5-flash' });
    expect(fromEnv.execution_mode).toBe('api');
    expect(fromEnv.api.model).toBe('gemini-2.5-flash');

    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({ execution_mode: 'subscription', api: { max_turns: 8 } }),
    );

    const merged = loadConfig(tmpRoot, { AG_DEFAULT_MODE: 'api', AG_MODEL: 'gemini-2.5-flash' });
    expect(merged.execution_mode).toBe('subscription');
    expect(merged.api.model).toBe('gemini-2.5-flash');
    expect(merged.api.max_turns).toBe(8);

    const envSkip = loadConfig(tmpRoot, { AG_DANGEROUSLY_SKIP_PERMISSIONS: 'true' });
    expect(envSkip.subscription.agy_dangerously_skip_permissions).toBe(true);

    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({
        subscription: {
          agy_dangerously_skip_permissions: false,
          agy_model: 'gemini-4-neon-high',
          agy_effort: 'high',
        },
      }),
    );
    const overridden = loadConfig(tmpRoot, { AG_DANGEROUSLY_SKIP_PERMISSIONS: 'true' });
    expect(overridden.subscription.agy_dangerously_skip_permissions).toBe(false);
    expect(overridden.subscription.agy_model).toBe('gemini-4-neon-high');
    expect(overridden.subscription.agy_effort).toBe('high');
  });
});
