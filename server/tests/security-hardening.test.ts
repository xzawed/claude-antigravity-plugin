import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleListArtifacts } from '../src/artifacts.js';
import { handleAgAuth, PendingAuthSessionManager } from '../src/auth.js';
import { ensureBridgeDirs, ensureGitignoreEntry, readReportMarkdown, syncHandoffTemplate } from '../src/bridge-fs.js';
import { handleAgCliAdmin } from '../src/cli-admin.js';
import { runCliInit } from '../src/cli-init.js';
import { loadConfig, maskSecrets } from '../src/config.js';
import { createSanitizedEnv, validateCommandPolicy } from '../src/engines/api-worker.js';
import { buildCliSpawnSpec } from '../src/engines/subscription.js';
import { absolutePathDirs } from '../src/exec-path.js';
import { rollbackCheckpoint } from '../src/git-guard.js';
import { assertReadablePath, assertWritablePath, validateLockedPathsConfig } from '../src/path-guard.js';
import { AgPluginError, BridgeManifest } from '../src/types.js';

const canSymlinkFile = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sym-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'a'), 'x');
    fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe('v1.6.1 critical & high security hardening (TC-S28 ~ TC-S35)', () => {
  let tmpRoot: string;
  let outsideDir: string;
  const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sec-ws-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sec-out-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(process.platform !== 'win32')(
    'TC-S28: Windows .cmd spawn quoting blocks command injection and %VAR% env expansion',
    () => {
      const mjs = path.join(tmpRoot, 'echo-args.mjs');
      const cmd = path.join(tmpRoot, 'mock-agy.cmd');
      fs.writeFileSync(mjs, 'console.log(JSON.stringify(process.argv.slice(2)));', 'utf8');
      fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');

      const payloads = [
        ['--print', 'hello" & echo INJECTED & "world'],
        ['--print', 'hello\\" & echo INJECTED & \\"world'],
        ['--print', '%OS% %TEST_CMD_SECRET%'],
        ['--json-schema', '{"type":"object","expr":"a|b&c>1<2%TEST_CMD_SECRET%"}'],
      ];

      for (const args of payloads) {
        const spec = buildCliSpawnSpec(cmd, args, 'win32');
        const out = execFileSync(spec.command, spec.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          env: { ...process.env, TEST_CMD_SECRET: 'TOP_SECRET_VALUE_999' },
        }).trim();
        expect(out).toBe(JSON.stringify(args));
        expect(out).not.toContain('TOP_SECRET_VALUE_999');
      }
    },
  );

  it('TC-S29: API worker validateCommandPolicy blocks pnpm/yarn/bun subcommand bypasses and dangerous flags; createSanitizedEnv strips custom keys case-insensitively', () => {
    const blocked = [
      'bun -e "console.log(1)"',
      'bun eval "process.exit(0)"',
      'pnpm exec rm -rf .',
      'pnpm dlx evil-pkg',
      'yarn exec sh',
      'yarn node -e "1"',
      'npm run build --script-shell=/bin/sh',
      'npm run test --node-options=--require=./evil.js',
      'pnpm run build --eval=1',
    ];
    for (const cmd of blocked) {
      expect(() => validateCommandPolicy(cmd), cmd).toThrow(AgPluginError);
    }

    // Legitimate verification scripts remain allowed
    expect(validateCommandPolicy('pnpm run build').bin).toBe('pnpm');
    expect(validateCommandPolicy('yarn test').bin).toBe('yarn');
    expect(validateCommandPolicy('bun run typecheck').bin).toBe('bun');

    const env = createSanitizedEnv(['CUSTOM_AI_TOKEN'], {
      PATH: '/usr/bin',
      gemini_api_key: 'secret-lower',
      Custom_Ai_Token: 'secret-custom',
      SAFE_VAR: 'keep-me',
    });
    expect(env.gemini_api_key).toBeUndefined();
    expect(env.Custom_Ai_Token).toBeUndefined();
    expect(env.SAFE_VAR).toBe('keep-me');
  });

  it.skipIf(!canSymlinkFile)(
    'TC-S30: path-guard resolves dangling symlinks and blocks writes to .git/hooks or outside workspace; blocks .ag-bridge/config.json & .envrc reads',
    () => {
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, '.git', 'hooks'), { recursive: true });

      // Dangling symlink pointing to non-existent .git/hooks/post-checkout
      fs.symlinkSync(
        path.join(tmpRoot, '.git', 'hooks', 'post-checkout'),
        path.join(tmpRoot, 'src', 'hook-link'),
      );
      // Dangling symlink pointing outside workspace
      fs.symlinkSync(
        path.join(outsideDir, 'pwned.txt'),
        path.join(tmpRoot, 'src', 'outside-link'),
      );

      expect(() => assertWritablePath(tmpRoot, 'src/hook-link', ['src'])).toThrow(AgPluginError);
      expect(() => assertWritablePath(tmpRoot, 'src/outside-link', ['src'])).toThrow(AgPluginError);
      expect(() => validateLockedPathsConfig(tmpRoot, ['src/outside-link'])).toThrow(AgPluginError);
    },
  );

  it('TC-S30b: path-guard blocks reading .ag-bridge/config.json and reading/writing .envrc / .env_local', () => {
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.ag-bridge', 'config.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, '.envrc'), 'export SECRET=1\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, '.env_local'), 'API=1\n', 'utf8');

    expect(() => assertReadablePath(tmpRoot, '.ag-bridge/config.json')).toThrow(AgPluginError);
    expect(() => assertReadablePath(tmpRoot, '.envrc')).toThrow(AgPluginError);
    expect(() => assertReadablePath(tmpRoot, '.env_local')).toThrow(AgPluginError);
    expect(() => assertWritablePath(tmpRoot, '.envrc', ['.envrc'])).toThrow(AgPluginError);
  });

  it('TC-S31: SessionStart cli-init and bridge-fs never write through symlinked .agent/ or .ag-bridge/ directories', () => {
    // Directory junctions work without admin privilege on Windows and symlinks work on POSIX
    fs.symlinkSync(outsideDir, path.join(tmpRoot, '.agent'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(outsideDir, path.join(tmpRoot, '.ag-bridge'), process.platform === 'win32' ? 'junction' : 'dir');

    const initRes = runCliInit({ workspaceRoot: tmpRoot, silent: true, forceTemplate: false, pluginRoot });
    expect(initRes.configCreated).toBe(false);
    expect(initRes.syncedTemplates).toEqual([]);
    expect(fs.readdirSync(outsideDir)).toEqual([]);

    expect(() => ensureBridgeDirs(tmpRoot)).toThrow(AgPluginError);
    const syncRes = syncHandoffTemplate(tmpRoot, pluginRoot);
    expect(syncRes.syncedPaths).toEqual([]);
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it('TC-S32: rollbackCheckpoint rejects option-injection gitCheckpointRef like --output=<path>', () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']);
    git(['config', 'user.email', 'sec@example.com']);
    git(['config', 'user.name', 'Sec']);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const x = 1;\n', 'utf8');
    git(['add', 'app.ts']);
    git(['commit', '-m', 'init']);

    const targetFile = path.join(outsideDir, 'injected-by-git-diff.txt');
    const badManifest: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'ag-inject-ref',
      title: 'Injected ref',
      mode: 'subscription',
      status: 'VERIFIED',
      lockedPaths: ['app.ts'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: `--output=${targetFile}`,
      gitCheckpointIsStash: false,
      gitUntrackedBaseline: [],
      artifacts: [],
    };

    expect(() => rollbackCheckpoint(tmpRoot, badManifest)).toThrow(AgPluginError);
    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('TC-S33: config trust fails closed when .git/info/exclude is a junction/directory, blocks Windows UNC app_path & tracked execution_mode, and redacts edge-case secrets', () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']);
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({
        execution_mode: 'api',
        subscription: { agy_dangerously_skip_permissions: true, app_path: '\\\\127.0.0.1\\c$\\evil.exe' },
      }),
      'utf8',
    );
    git(['add', '-f', '.ag-bridge/config.json']);

    // Replace .git/info with a junction so resolveGitExcludePath returns null, and strip git from PATH
    const infoDir = path.join(tmpRoot, '.git', 'info');
    fs.rmSync(infoDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, infoDir, process.platform === 'win32' ? 'junction' : 'dir');

    const savedPath = process.env.PATH;
    const savedPathWin = process.env.Path;
    process.env.PATH = '';
    if (process.platform === 'win32') process.env.Path = '';
    try {
      const cfg = loadConfig(tmpRoot, { AG_DEFAULT_MODE: 'subscription' });
      expect(cfg.subscription.agy_dangerously_skip_permissions).toBe(false);
      expect(cfg.execution_mode).toBe('subscription');
      expect(cfg.subscription.app_path).toBe('auto');
      expect(cfg.ignoredSettings?.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (process.platform === 'win32') {
        if (savedPathWin === undefined) delete process.env.Path;
        else process.env.Path = savedPathWin;
      }
    }

    // In a real git repo whose .git/info is a junction, ensureGitignoreEntry must NOT edit .gitignore
    const ig = ensureGitignoreEntry(tmpRoot);
    expect(ig).toEqual({ updated: false, protected: false, file: 'git-info-exclude' });
    expect(fs.existsSync(path.join(tmpRoot, '.gitignore'))).toBe(false);

    // maskSecrets handles tokens ending in `-` and overlapping candidate lengths
    const hyphenTok = 'sk-proj-1234567890abcdefghij-';
    expect(maskSecrets(`key=${hyphenTok} done`)).toBe('key=[REDACTED] done');
    expect(maskSecrets('longsecretvalue123', ['longsecret', 'longsecretvalue123'])).toBe('[REDACTED]');

    // exec-path envValue respects POSIX case sensitivity and Windows override precedence
    expect(absolutePathDirs('linux', { path: '', PATH: '/usr/local/bin:/usr/bin' })).toEqual([
      '/usr/local/bin',
      '/usr/bin',
    ]);
    expect(absolutePathDirs('win32', { Path: 'C:\\Old', PATH: 'C:\\New' })).toEqual(['C:\\New']);
  });

  it('TC-S34: list_ag_artifacts refuses symlinked artifact dirs/logs; ag_cli_admin rejects leading-dash server names; auth rejects newline OAuth codes', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'agy-cli.log'), 'OUTSIDE_SECRET_DATA\n', 'utf8');
    fs.symlinkSync(
      outsideDir,
      path.join(tmpRoot, '.ag-bridge', 'artifacts', 'ag-sym-task'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const artRes = handleListArtifacts({ taskId: 'ag-sym-task', workspaceRoot: tmpRoot });
    expect(artRes.artifacts).toEqual([]);
    expect(artRes.logTail).toBeUndefined();
    expect(readReportMarkdown(tmpRoot)).toBeNull();

    // ag_cli_admin rejects leading `-` server names and invalid env/header formats
    const detDeps = {
      platform: 'linux' as const,
      env: {},
      homedir: '/tmp/none',
      existsSync: (p: string) => p === '/usr/bin/agy',
      findBinary: (b: string) => (b === 'agy' ? '/usr/bin/agy' : undefined),
    };
    const badName = await handleAgCliAdmin(
      { action: 'mcp_remove', name: '--all', workspaceRoot: tmpRoot },
      { detectorDeps: detDeps },
    );
    expect(badName.ok).toBe(false);
    expect(badName.errorCode).toBe('CLI_ADMIN_FAILED');

    const badEnv = await handleAgCliAdmin(
      {
        action: 'mcp_add',
        name: 'demo',
        commandOrUrl: 'node',
        envVars: ['--bad-flag'],
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: detDeps },
    );
    expect(badEnv.ok).toBe(false);

    // auth rejects newline injection in OAuth code
    const mgr = new PendingAuthSessionManager();
    const fakeChild = {
      pid: 99999,
      stdin: { write: () => true, end: () => {} },
      stdout: null,
      stderr: null,
      once: () => fakeChild,
      on: () => fakeChild,
      kill: () => true,
    } as unknown as import('node:child_process').ChildProcess;
    const sess = mgr.register(tmpRoot, '/usr/bin/agy', 'linux', fakeChild);
    const authRes = await handleAgAuth(
      { action: 'complete', sessionId: sess.sessionId, code: '4/0validcode\nextra-line', workspaceRoot: tmpRoot },
      { detectorDeps: detDeps, sessionManager: mgr },
    );
    expect(authRes.ok).toBe(false);
    expect(authRes.errorCode).toBe('AUTH_LOGIN_FAILED');
    expect(authRes.errorMessage).toContain('Control characters');
    mgr.disposeAll();
  });
});
