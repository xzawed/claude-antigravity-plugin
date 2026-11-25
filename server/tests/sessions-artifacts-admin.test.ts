import { ChildProcess, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleListArtifacts } from '../src/artifacts.js';
import { ensureBridgeDirs, getArtifactsDir, writeManifest, writeReportMarkdown } from '../src/bridge-fs.js';
import {
  buildMcpAddArgs,
  compareSemver,
  detectPluginInstallMethod,
  handleAgCliAdmin,
} from '../src/cli-admin.js';
import { DetectorDeps } from '../src/detector.js';
import { handleRollbackAgTask } from '../src/index.js';
import {
  buildStreamSessionArgs,
  handleAgSession,
  PersistentSessionManager,
} from '../src/sessions.js';
import { DEFAULT_BRIDGE_CONFIG } from '../src/types.js';

interface FakeStreamChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

function createFakeStreamChild(): FakeStreamChild {
  const proc = new EventEmitter() as FakeStreamChild;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit('close', 0);
    return true;
  };
  return proc;
}

function makeAgyDetectorDeps(): DetectorDeps {
  return {
    platform: 'linux',
    env: {},
    homedir: '/tmp/nonexistent-home',
    existsSync: (p) => p === '/usr/local/bin/agy',
    findBinary: (bin) => (bin === 'agy' ? '/usr/local/bin/agy' : undefined),
  };
}

describe('Persistent sessions, artifacts viewer & CLI admin (TC-U27 ~ TC-U32)', () => {
  let tmpRoot: string;
  let sessionManager: PersistentSessionManager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v14-test-'));
    sessionManager = new PersistentSessionManager(60_000);
  });

  afterEach(() => {
    sessionManager.disposeAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-S19d: ag_session start reports the settings it ignored from a config git tracks', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({ subscription: { agy_dangerously_skip_permissions: true } }),
    );
    execFileSync('git', ['add', '-f', '.ag-bridge/config.json'], { cwd: tmpRoot, stdio: 'ignore' });

    const res = await handleAgSession(
      { action: 'start', workspaceRoot: tmpRoot },
      {
        sessionManager,
        detectorDeps: {
          platform: 'linux',
          env: {},
          homedir: '/tmp/nonexistent-home',
          existsSync: () => false,
          findBinary: () => undefined,
        },
      },
    );
    expect(res.warnings.join('\n')).toContain('subscription.agy_dangerously_skip_permissions');
  });

  it('TC-U27: buildStreamSessionArgs includes stream-json input/output, skip-permissions, model, and effort', () => {
    const args = buildStreamSessionArgs(
      {
        action: 'start',
        model: 'gemini-4-neon-high',
        effort: 'xhigh',
        dangerouslySkipPermissions: true,
        sandbox: false,
        addDirs: ['../shared'],
      },
      DEFAULT_BRIDGE_CONFIG,
    );
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mode');
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-4-neon-high');
    expect(args).toContain('--effort');
    expect(args).toContain('xhigh');
    expect(args).toContain('--add-dir');
    expect(args).toContain('../shared');
  });

  it('TC-U28: persistent session handles multi-turn NDJSON protocol, tracks cache hits, enforces SESSION_BUSY, and closes cleanly', async () => {
    const fakeChild = createFakeStreamChild();
    let turnCount = 0;
    let stdinBuf = '';

    fakeChild.stdin.on('data', (chunk) => {
      stdinBuf += chunk.toString('utf8');
      const lines = stdinBuf.split('\n');
      stdinBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { event: string; message: { content: string } };
        expect(msg.event).toBe('user');
        turnCount += 1;
        if (turnCount === 1) {
          fakeChild.stdout.write(
            JSON.stringify({
              event: 'init',
              conversation_id: 'conv-persist-1',
              init: { model: 'gemini-3.8-flash-low', permission_mode: 'always-proceed' },
            }) + '\n',
          );
          fakeChild.stdout.write(
            JSON.stringify({
              event: 'result',
              result: {
                conversation_id: 'conv-persist-1',
                status: 'SUCCESS',
                response: 'apple',
                duration_seconds: 1.2,
                num_turns: 1,
                usage: {
                  input_tokens: 10000,
                  output_tokens: 2,
                  thinking_tokens: 0,
                  cache_read_tokens: 0,
                  total_tokens: 10002,
                },
              },
            }) + '\n',
          );
        } else {
          fakeChild.stdout.write(
            JSON.stringify({
              event: 'result',
              result: {
                conversation_id: 'conv-persist-1',
                status: 'SUCCESS',
                response: `recalled:${msg.message.content}`,
                duration_seconds: 2.0,
                num_turns: 2,
                usage: {
                  input_tokens: 10200,
                  output_tokens: 6,
                  thinking_tokens: 0,
                  cache_read_tokens: 9900,
                  total_tokens: 10206,
                },
              },
            }) + '\n',
          );
        }
      }
    });

    const started = await handleAgSession(
      {
        action: 'start',
        prompt: 'Remember apple',
        dangerouslySkipPermissions: true,
        workspaceRoot: tmpRoot,
      },
      {
        detectorDeps: makeAgyDetectorDeps(),
        sessionManager,
        spawnFn: () => fakeChild as unknown as ChildProcess,
      },
    );

    expect(started.ok).toBe(true);
    expect(started.sessionId).toMatch(/^ag-sess-/);
    expect(started.response).toBe('apple');
    expect(started.session?.conversationId).toBe('conv-persist-1');
    expect(started.session?.numTurns).toBe(1);

    const turn2 = await handleAgSession(
      {
        action: 'send',
        sessionId: started.sessionId,
        prompt: 'What word?',
        workspaceRoot: tmpRoot,
      },
      { sessionManager },
    );
    expect(turn2.ok).toBe(true);
    expect(turn2.response).toBe('recalled:What word?');
    expect(turn2.metrics?.numTurns).toBe(2);
    expect(turn2.metrics?.usage?.cacheReadTokens).toBe(9900);

    const listed = await handleAgSession({ action: 'list', workspaceRoot: tmpRoot }, { sessionManager });
    expect(listed.ok).toBe(true);
    expect(listed.sessions?.length).toBe(1);

    const closed = await handleAgSession(
      { action: 'close', sessionId: started.sessionId, workspaceRoot: tmpRoot },
      { sessionManager },
    );
    expect(closed.ok).toBe(true);
    expect(closed.session?.active).toBe(false);
    expect(fakeChild.killed).toBe(true);
  });

  it('TC-U29: list_ag_artifacts classifies screenshots/logs/json and masks secrets in report & log tail', () => {
    ensureBridgeDirs(tmpRoot);
    const taskId = 'ag-art-test-1';
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId,
      title: 'Visual QA',
      mode: 'subscription',
      status: 'VERIFIED',
      lockedPaths: ['src/'],
      createdAt: '2026-11-23T01:00:00.000Z',
      updatedAt: '2026-11-23T01:02:00.000Z',
      artifacts: [],
    });
    const artDir = getArtifactsDir(tmpRoot, taskId);
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'checkout.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(artDir, 'trace.json'), '{"ok":true}', 'utf8');
    const fakeToken = ['AIza', 'SySecretTokenValue123456789012345'].join('');
    fs.writeFileSync(
      path.join(artDir, 'agy-cli.log'),
      `line1\nkey=${fakeToken}\nline3\n`,
      'utf8',
    );
    writeReportMarkdown(tmpRoot, `# Report\nToken ${fakeToken}`);

    const res = handleListArtifacts({ taskId, workspaceRoot: tmpRoot });
    expect(res.ok).toBe(true);
    expect(res.taskId).toBe(taskId);
    expect(res.artifacts.map((a) => `${a.name}:${a.kind}`)).toEqual([
      'agy-cli.log:log',
      'checkout.png:screenshot',
      'trace.json:json',
    ]);
    expect(res.logTail).not.toContain(fakeToken);
    expect(res.reportMarkdown).not.toContain(fakeToken);
    expect(res.availableTasks.length).toBe(1);
  });

  it('TC-S06: blocks path traversal in taskId across getArtifactsDir and handleListArtifacts', () => {
    expect(() => getArtifactsDir(tmpRoot, '../../etc')).toThrow(/PATH_TRAVERSAL_BLOCKED|Invalid taskId/);
    expect(() => handleListArtifacts({ taskId: '../config', workspaceRoot: tmpRoot })).toThrow(
      /Invalid taskId/,
    );
    expect(() => handleListArtifacts({ taskId: '..\\..\\secret', workspaceRoot: tmpRoot })).toThrow(
      /Invalid taskId/,
    );
  });

  it('TC-U30: buildMcpAddArgs places flags strictly before server name and inserts -- when args start with hyphen', () => {
    const args = buildMcpAddArgs({
      name: 'fs',
      commandOrUrl: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
      serverType: 'stdio',
      envVars: ['NODE_ENV=production'],
    });
    expect(args).toEqual([
      'mcp',
      'add',
      '--type',
      'stdio',
      '--env',
      'NODE_ENV=production',
      'fs',
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/work',
    ]);
  });

  it('TC-U31: ag_cli_admin mcp_sync_from_claude skips antigravity-delegate self-recursion and supports dryRun vs apply', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'antigravity-delegate': { command: 'node', args: ['dist/index.js'] },
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      }),
      'utf8',
    );

    const calls: string[][] = [];
    const runner = async (_cli: string, args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: 'Added github', stderr: '' };
    };

    const dry = await handleAgCliAdmin(
      { action: 'mcp_sync_from_claude', dryRun: true, workspaceRoot: tmpRoot },
      { detectorDeps: makeAgyDetectorDeps(), runCliFn: runner },
    );
    expect(dry.ok).toBe(true);
    expect(calls.length).toBe(0);
    expect(dry.syncedServers?.find((s) => s.name === 'antigravity-delegate')?.status).toBe('skipped');
    expect(dry.syncedServers?.find((s) => s.name === 'github')?.status).toBe('planned');

    const applied = await handleAgCliAdmin(
      { action: 'mcp_sync_from_claude', dryRun: false, workspaceRoot: tmpRoot },
      { detectorDeps: makeAgyDetectorDeps(), runCliFn: runner },
    );
    expect(applied.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(applied.syncedServers?.find((s) => s.name === 'github')?.status).toBe('synced');
  });

  it('TC-U32: ag_cli_admin wraps remote_status and truncates long changelog output safely', async () => {
    const longLog = Array.from({ length: 120 }, (_, i) => `Release note line ${i + 1}`).join('\n');
    const res = await handleAgCliAdmin(
      { action: 'changelog', maxLines: 20, workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps(),
        runCliFn: async (_cli, args) => {
          expect(args).toEqual(['changelog']);
          return { exitCode: 0, stdout: longLog, stderr: '' };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Release note line 20');
    expect(res.output).toContain('truncated 100 additional lines');

    // Control-char injection guard on mcp_add headers/env/args
    const badHeader = await handleAgCliAdmin(
      {
        action: 'mcp_add',
        name: 'api',
        commandOrUrl: 'https://example.com/mcp',
        headers: ['X-Test: ok\r\nX-Injected: evil'],
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps() },
    );
    expect(badHeader.ok).toBe(false);
    expect(badHeader.errorCode).toBe('CLI_ADMIN_FAILED');
    expect(badHeader.errorMessage).toContain('Control characters');
  });

  it('TC-S26: ag_cli_admin redacts env/header secrets on error, blocks control chars in .mcp.json sync, syncs headers, and reports failures', async () => {
    const failAdd = await handleAgCliAdmin(
      {
        action: 'mcp_add',
        name: 'private-api',
        commandOrUrl: 'https://api.example.com/mcp',
        serverType: 'http',
        envVars: ['CUSTOM_SECRET=super-secret-value-999'],
        headers: ['X-API-Key: my-private-header-token'],
        workspaceRoot: tmpRoot,
      },
      {
        detectorDeps: makeAgyDetectorDeps(),
        runCliFn: async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }),
      },
    );
    expect(failAdd.ok).toBe(false);
    expect(failAdd.errorMessage).not.toContain('super-secret-value-999');
    expect(failAdd.errorMessage).not.toContain('my-private-header-token');
    expect(failAdd.errorMessage).toContain('CUSTOM_SECRET=[REDACTED]');
    expect(failAdd.errorMessage).toContain('X-API-Key: [REDACTED]');

    // .mcp.json with headers + control-char injection + failing server
    fs.writeFileSync(
      path.join(tmpRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          injected: { command: 'npx', args: ['ok\r\nwhoami'] },
          remote: {
            url: 'https://mcp.example.com',
            headers: { 'X-Custom': 'secret-hdr-val' },
          },
        },
      }),
      'utf8',
    );
    const seenCalls: string[][] = [];
    const syncRes = await handleAgCliAdmin(
      { action: 'mcp_sync_from_claude', dryRun: false, workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps(),
        runCliFn: async (_cli, args) => {
          seenCalls.push(args);
          return { exitCode: 1, stdout: '', stderr: 'boom' };
        },
      },
    );
    expect(syncRes.ok).toBe(false);
    expect(syncRes.errorCode).toBe('CLI_ADMIN_FAILED');
    expect(syncRes.syncedServers?.find((s) => s.name === 'injected')?.status).toBe('skipped');
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]).toContain('--header');
    expect(seenCalls[0]).toContain('X-Custom: secret-hdr-val');
  });

  it('TC-U41: persistent session archives checkpoint for rollback_ag_task and closes child on turn timeout', async () => {
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: tmpRoot,
        stdio: 'ignore',
      });
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const v = 1;\n', 'utf8');
    git(['add', 'app.ts']);
    git(['commit', '-qm', 'init']);

    const hangingChild = createFakeStreamChild();
    const started = await handleAgSession(
      { action: 'start', workspaceRoot: tmpRoot },
      {
        detectorDeps: makeAgyDetectorDeps(),
        sessionManager,
        spawnFn: () => hangingChild as unknown as ChildProcess,
      },
    );
    expect(started.ok).toBe(true);
    expect(started.session?.checkpointTaskId).toBeTruthy();

    // Simulate edits made during the session and verify rollback_ag_task restores them
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const v = 999;\n', 'utf8');
    const rb = await handleRollbackAgTask({
      taskId: started.session!.checkpointTaskId,
      workspaceRoot: tmpRoot,
    });
    expect(rb.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const v = 1;\n');

    // Turn timeout closes the session and kills the child to prevent protocol desync
    const live = sessionManager.get(started.sessionId);
    expect(live).toBeDefined();
    await expect(sessionManager.sendTurn(live!, 'hang forever', 0.01)).rejects.toThrow(/timed out/i);
    expect(hangingChild.killed).toBe(true);
    expect(sessionManager.get(started.sessionId)).toBeUndefined();
  }, 15_000);

  it('TC-U42: list_ag_artifacts skips non-taskId subdirectories instead of crashing', () => {
    const artRoot = path.join(tmpRoot, '.ag-bridge', 'artifacts');
    fs.mkdirSync(path.join(artRoot, 'my screenshots'), { recursive: true });
    fs.writeFileSync(path.join(artRoot, 'my screenshots', 'note.txt'), 'hi', 'utf8');
    fs.mkdirSync(path.join(artRoot, 'ag-valid-1'), { recursive: true });
    fs.writeFileSync(path.join(artRoot, 'ag-valid-1', 'shot.png'), Buffer.from([0x89, 0x50]), 'utf8');

    const res = handleListArtifacts({ workspaceRoot: tmpRoot });
    expect(res.ok).toBe(true);
    expect(res.taskId).toBe('ag-valid-1');
    expect(res.artifacts.map((a) => a.name)).toEqual(['shot.png']);
  });

  it('TC-U54: ag_cli_admin plugin_status compares semver, detects install method, and works without agy CLI', async () => {
    expect(compareSemver('1.6.1', '1.7.0')).toBe(-1);
    expect(compareSemver('1.6.1', '1.6.1')).toBe(0);
    expect(compareSemver('1.6.1-rc.1', '1.6.1')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);

    const mktRoot = path.join(tmpRoot, '.claude', 'plugins', 'cache', 'claude-antigravity-plugin', 'antigravity-delegate', '1.6.1');
    fs.mkdirSync(path.join(mktRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(mktRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.1' }));
    expect(detectPluginInstallMethod(mktRoot)).toBe('marketplace');

    const noAgyDeps: DetectorDeps = {
      platform: 'linux',
      env: {},
      homedir: '/tmp/nonexistent-home',
      existsSync: () => false,
      findBinary: () => undefined,
    };

    // Update available
    const statusRes = await handleAgCliAdmin(
      { action: 'plugin_status', workspaceRoot: tmpRoot },
      {
        pluginRoot: mktRoot,
        detectorDeps: noAgyDeps,
        fetchLatestReleaseFn: async () => ({
          version: '1.7.0',
          releaseUrl: 'https://github.com/xzawed/claude-antigravity-plugin/releases/tag/v1.7.0',
        }),
      },
    );
    expect(statusRes.ok).toBe(true);
    expect(statusRes.pluginUpdate?.currentVersion).toBe('1.6.1');
    expect(statusRes.pluginUpdate?.latestVersion).toBe('1.7.0');
    expect(statusRes.pluginUpdate?.updateAvailable).toBe(true);
    expect(statusRes.pluginUpdate?.installMethod).toBe('marketplace');
    expect(statusRes.output).toContain('v1.6.1 -> v1.7.0');

    // Offline fallback returns ok: true with warning
    const offlineRes = await handleAgCliAdmin(
      { action: 'plugin_status', workspaceRoot: tmpRoot },
      {
        pluginRoot: mktRoot,
        detectorDeps: noAgyDeps,
        fetchLatestReleaseFn: async () => null,
      },
    );
    expect(offlineRes.ok).toBe(true);
    expect(offlineRes.pluginUpdate?.updateAvailable).toBeUndefined();
    expect(offlineRes.warnings.length).toBeGreaterThan(0);
  });

  it('TC-U55: ag_cli_admin plugin_update updates marketplace caches via claude CLI and local git clones via fast-forward pull', async () => {
    // 1. Marketplace install path -> runs marketplace update + plugin update
    const mktRoot = path.join(tmpRoot, '.claude', 'plugins', 'cache', 'claude-antigravity-plugin', 'antigravity-delegate', '1.6.1');
    fs.mkdirSync(path.join(mktRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(mktRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.1' }));

    const claudeCalls: Array<{ cli: string; args: string[] }> = [];
    const mktUpdate = await handleAgCliAdmin(
      { action: 'plugin_update', workspaceRoot: tmpRoot },
      {
        pluginRoot: mktRoot,
        detectorDeps: {
          platform: 'linux',
          env: {},
          homedir: '/tmp/nonexistent-home',
          existsSync: (p) => p === '/usr/local/bin/claude',
          findBinary: (b) => (b === 'claude' ? '/usr/local/bin/claude' : undefined),
        },
        runCliFn: async (cli, args) => {
          claudeCalls.push({ cli, args });
          return { exitCode: 0, stdout: 'Updated to 1.7.0', stderr: '' };
        },
      },
    );
    expect(mktUpdate.ok).toBe(true);
    expect(mktUpdate.pluginUpdate?.updated).toBe(true);
    expect(mktUpdate.pluginUpdate?.reloadRequired).toBe(true);
    expect(claudeCalls).toEqual([
      { cli: '/usr/local/bin/claude', args: ['plugin', 'marketplace', 'update', 'claude-antigravity-plugin'] },
      { cli: '/usr/local/bin/claude', args: ['plugin', 'update', 'antigravity-delegate@claude-antigravity-plugin'] },
    ]);

    // 2. Local git clone -> uses pullRepoFn without needing agy or claude
    const cloneRoot = path.join(tmpRoot, 'local-clone');
    fs.mkdirSync(path.join(cloneRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(cloneRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(cloneRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.1' }));
    expect(detectPluginInstallMethod(cloneRoot)).toBe('git_clone');

    const cloneUpdate = await handleAgCliAdmin(
      { action: 'plugin_update', workspaceRoot: tmpRoot },
      {
        pluginRoot: cloneRoot,
        pullRepoFn: (dir) => {
          expect(dir).toBe(cloneRoot);
          fs.writeFileSync(path.join(cloneRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.2' }));
          return {
            ok: true,
            alreadyUpToDate: false,
            previousHead: 'abc1234',
            currentHead: 'def5678',
            output: 'Updating abc1234..def5678\nFast-forward',
          };
        },
      },
    );
    expect(cloneUpdate.ok).toBe(true);
    expect(cloneUpdate.pluginUpdate?.currentVersion).toBe('1.6.2');
    expect(cloneUpdate.pluginUpdate?.updated).toBe(true);
    expect(cloneUpdate.pluginUpdate?.reloadRequired).toBe(true);

    // 3. Unknown install directory -> returns helpful 2-line marketplace guidance
    const plainRoot = path.join(tmpRoot, 'plain-dir');
    fs.mkdirSync(path.join(plainRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plainRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.1' }));
    const unknownRes = await handleAgCliAdmin(
      { action: 'plugin_update', workspaceRoot: tmpRoot },
      { pluginRoot: plainRoot },
    );
    expect(unknownRes.ok).toBe(false);
    expect(unknownRes.output).toContain('/plugin marketplace add xzawed/claude-antigravity-plugin');
  });
});
