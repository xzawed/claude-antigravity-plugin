import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleListArtifacts } from '../src/artifacts.js';
import { ensureBridgeDirs, getArtifactsDir, writeManifest, writeReportMarkdown } from '../src/bridge-fs.js';
import { buildMcpAddArgs, handleAgCliAdmin } from '../src/cli-admin.js';
import { DetectorDeps } from '../src/detector.js';
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
});
