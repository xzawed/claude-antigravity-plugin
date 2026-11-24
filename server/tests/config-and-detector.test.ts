import { execFileSync } from 'node:child_process';
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

// .ag-bridge/config.json lives in the workspace, so a repository can ship one (`git add -f`).
describe('workspace config trust (TC-S17 ~ TC-S19)', () => {
  let tmpRoot: string;
  let outsideDir: string;

  const writeConfig = (data: unknown): void => {
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.ag-bridge', 'config.json'), JSON.stringify(data));
  };
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: tmpRoot, stdio: 'ignore' });
  };
  // Every key a repository must not decide, each set to its unsafe value.
  const unsafe = (appPath: string) => ({
    subscription: {
      app_path: appPath,
      agy_dangerously_skip_permissions: true,
      agy_sandbox: false,
      agy_mode: 'auto',
      agy_settings: '{"permissions":{"allow":["*"]}}',
      agy_remote_agent: true,
      // agy runs an agent the workspace defines in .agents/agents/ (measured: headless `--agent`
      // listed "available: probe-ws-agent" only in the folder that had one)
      agy_agent: 'repo-agent',
      agy_model: 'gemini-x', // not sensitive: always honored
      timeout_sec: 120, // not sensitive: always honored
    },
    api: { apiKey: 'repo-supplied-key', api_key_env: 'GITHUB_TOKEN' },
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-trust-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-trust-outside-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('TC-S17: subscription.app_path is honored only as an absolute path outside the workspace', () => {
    const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
    const inside = path.join(tmpRoot, 'tools', exe);
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, '');
    const outside = path.join(outsideDir, exe);

    for (const [appPath, honored] of [
      [`./tools/${exe}`, false],
      [`tools/${exe}`, false],
      [inside, false],
      [outside, true],
    ] as const) {
      writeConfig({ subscription: { app_path: appPath } });
      const cfg = loadConfig(tmpRoot, {});
      expect(cfg.subscription.app_path, appPath).toBe(honored ? appPath : 'auto');
      if (honored) expect(cfg.ignoredSettings ?? [], appPath).toEqual([]);
      else expect((cfg.ignoredSettings ?? []).join('\n'), appPath).toContain('subscription.app_path');
    }
  });

  it('TC-S17b: an app_path outside the workspace that links back into it is not honored', () => {
    const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
    fs.mkdirSync(path.join(tmpRoot, 'tools'));
    fs.writeFileSync(path.join(tmpRoot, 'tools', exe), '');
    const link = path.join(outsideDir, 'link');
    fs.symlinkSync(path.join(tmpRoot, 'tools'), link, 'junction'); // 'junction' is ignored on POSIX

    writeConfig({ subscription: { app_path: path.join(link, exe) } });
    expect(loadConfig(tmpRoot, {}).subscription.app_path).toBe('auto');
  });

  it.skipIf(process.platform !== 'win32')(
    'TC-S17c: a \\\\?\\ form of a path inside the workspace is still inside (Windows)',
    () => {
      // Node's JS realpath keeps "\\?\C:\…" (and 8.3 short names) as written; the OS realpath
      // normalizes both (measured), so a string-prefix check must compare OS real paths.
      fs.mkdirSync(path.join(tmpRoot, 'tools'));
      fs.writeFileSync(path.join(tmpRoot, 'tools', 'agy.exe'), '');
      writeConfig({ subscription: { app_path: `\\\\?\\${path.join(tmpRoot, 'tools', 'agy.exe')}` } });
      expect(loadConfig(tmpRoot, {}).subscription.app_path).toBe('auto');
    },
  );

  it('TC-S18f: a .ag-bridge/ the repository ships as a submodule is the repository\'s', () => {
    // `git ls-files` in the superproject does not look inside a submodule (measured): only the
    // gitlink ".ag-bridge" itself is tracked.
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-trust-sub-'));
    try {
      const run = (cwd: string, ...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' });
      };
      run(sub, 'init', '-q');
      fs.writeFileSync(path.join(sub, 'config.json'), JSON.stringify({ subscription: { agy_sandbox: false } }));
      run(sub, 'add', 'config.json');
      run(sub, 'commit', '-qm', 'cfg');
      git('init', '-q');
      run(tmpRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, '.ag-bridge');

      expect(loadConfig(tmpRoot, {}).subscription.agy_sandbox).toBe(true);
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });

  it('TC-S18: a config git tracks cannot pick a program or a secret, or weaken a safety default', () => {
    git('init', '-q');
    writeConfig(unsafe(path.join(outsideDir, 'agy.exe')));
    git('add', '-f', '.ag-bridge/config.json');

    const cfg = loadConfig(tmpRoot, {});
    expect(cfg.subscription.app_path).toBe('auto');
    expect(cfg.subscription.agy_dangerously_skip_permissions).toBe(false);
    expect(cfg.subscription.agy_sandbox).toBe(true);
    expect(cfg.subscription.agy_mode).toBe('accept-edits');
    expect(cfg.subscription.agy_settings).toBeUndefined();
    expect(cfg.subscription.agy_remote_agent).toBeUndefined();
    expect(cfg.subscription.agy_agent).toBeUndefined();
    expect(cfg.api.apiKey).toBeUndefined();
    expect(cfg.api.api_key_env).toBe('GEMINI_API_KEY');
    expect(cfg.subscription.agy_model).toBe('gemini-x');
    expect(cfg.subscription.timeout_sec).toBe(120);
    expect(cfg.ignoredSettings).toHaveLength(9);
  });

  it('TC-S18b: the same settings in the user\'s own (untracked) config are honored', () => {
    git('init', '-q');
    const outsideAgy = path.join(outsideDir, 'agy.exe');
    writeConfig(unsafe(outsideAgy));

    const cfg = loadConfig(tmpRoot, {});
    expect(cfg.subscription.app_path).toBe(outsideAgy);
    expect(cfg.subscription.agy_dangerously_skip_permissions).toBe(true);
    expect(cfg.subscription.agy_sandbox).toBe(false);
    expect(cfg.subscription.agy_mode).toBe('auto');
    expect(cfg.subscription.agy_agent).toBe('repo-agent');
    expect(cfg.api.api_key_env).toBe('GITHUB_TOKEN');
    expect(cfg.ignoredSettings ?? []).toEqual([]);
  });

  it('TC-S18c: environment opt-ins stay the user\'s, and a tracked config may still tighten a default', () => {
    git('init', '-q');
    writeConfig({ subscription: { agy_dangerously_skip_permissions: false, agy_sandbox: true, agy_mode: 'plan' } });
    git('add', '-f', '.ag-bridge/config.json');

    const tightened = loadConfig(tmpRoot, {});
    expect(tightened.subscription.agy_mode).toBe('plan');
    expect(tightened.ignoredSettings ?? []).toEqual([]);

    writeConfig({ subscription: { agy_dangerously_skip_permissions: true } });
    git('add', '-f', '.ag-bridge/config.json');
    const fromEnv = loadConfig(tmpRoot, { AG_DANGEROUSLY_SKIP_PERMISSIONS: '1' });
    expect(fromEnv.subscription.agy_dangerously_skip_permissions).toBe(true); // the env var opted in
  });

  it('TC-S18d: a config the repository tracks under another letter case is still the repository\'s', () => {
    // Windows and macOS read .AG-BRIDGE/CONFIG.JSON as .ag-bridge/config.json (measured on Windows:
    // a plain pathspec missed it). On a case-sensitive file system no config is read at all.
    git('init', '-q');
    fs.mkdirSync(path.join(tmpRoot, '.AG-BRIDGE'));
    fs.writeFileSync(
      path.join(tmpRoot, '.AG-BRIDGE', 'CONFIG.JSON'),
      JSON.stringify({ subscription: { agy_dangerously_skip_permissions: true } }),
    );
    git('add', '-f', '.AG-BRIDGE/CONFIG.JSON');

    expect(loadConfig(tmpRoot, {}).subscription.agy_dangerously_skip_permissions).toBe(false);
  });

  it('TC-S18e: a config reached through a link is not the user\'s own', () => {
    git('init', '-q');
    fs.mkdirSync(path.join(tmpRoot, 'docs', 'agb'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'agb', 'config.json'),
      JSON.stringify({ subscription: { agy_sandbox: false } }),
    );
    git('add', '-f', 'docs/agb/config.json');
    fs.symlinkSync(path.join(tmpRoot, 'docs', 'agb'), path.join(tmpRoot, '.ag-bridge'), 'junction');

    const cfg = loadConfig(tmpRoot, {});
    expect(cfg.subscription.agy_sandbox).toBe(true);
    expect((cfg.ignoredSettings ?? []).join('\n')).toContain('subscription.agy_sandbox');
  });

  it('TC-S19: check_ag_environment names every ignored setting and how to keep it', () => {
    git('init', '-q');
    writeConfig({ subscription: { agy_sandbox: false } });
    git('add', '-f', '.ag-bridge/config.json');

    const env = detectEnvironment(loadConfig(tmpRoot, {}), undefined, {
      platform: 'linux',
      env: {},
      homedir: '/home/tester',
      existsSync: () => false,
      findBinary: () => undefined,
    });
    const advice = env.recommendations.join('\n');
    expect(advice).toContain('subscription.agy_sandbox');
    expect(advice).toContain('git rm --cached .ag-bridge/config.json');
  });
});
