import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveManifest, writeManifest } from '../src/bridge-fs.js';
import { createCheckpoint } from '../src/git-guard.js';

describe('MCP Stdio protocol integration (TC-I01, TC-I06)', () => {
  let tmpRoot: string;
  const distIndex = path.resolve(import.meta.dirname, '..', 'dist', 'index.js');

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mcp-stdio-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 });
  });

  it('TC-I01: exposes all 12 MCP tools over clean stdio JSON-RPC and executes check_ag_environment + ag_auth + get_ag_job + ag_session + list_ag_artifacts', async () => {
    if (!fs.existsSync(distIndex)) {
      throw new Error(`Built server not found at ${distIndex}. Run "npm run build" before tests.`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'test-mcp-client', version: '1.4.0' });
    await client.connect(transport);

    try {
      const toolsRes = await client.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'ag_auth',
        'ag_cli_admin',
        'ag_session',
        'cancel_ag_job',
        'check_ag_environment',
        'delegate_to_antigravity',
        'get_ag_job',
        'get_ag_usage',
        'list_ag_artifacts',
        'list_ag_capabilities',
        'rollback_ag_task',
        'start_ag_task',
      ]);

      const envCall = await client.callTool({
        name: 'check_ag_environment',
        arguments: { workspaceRoot: tmpRoot },
      });

      const content = envCall.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThan(0);
      expect(content[0].type).toBe('text');
      const parsed = JSON.parse(content[0].text ?? '{}') as {
        configuredMode: string;
        bridge: { currentStatus: string };
      };
      expect(parsed.configuredMode).toBe('auto');
      expect(parsed.bridge.currentStatus).toBe('IDLE');

      const authLogoutCall = await client.callTool({
        name: 'ag_auth',
        arguments: { action: 'logout', workspaceRoot: tmpRoot },
      });
      const authLogout = JSON.parse(
        ((authLogoutCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; status: string };
      expect(authLogout.ok).toBe(true);
      expect(authLogout.status).toBe('LOGOUT_INSTRUCTIONS');

      const authCancelCall = await client.callTool({
        name: 'ag_auth',
        arguments: { action: 'cancel', workspaceRoot: tmpRoot },
      });
      const authCancel = JSON.parse(
        ((authCancelCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; status: string };
      expect(authCancel.ok).toBe(true);
      expect(authCancel.status).toBe('CANCELLED');

      const jobsCall = await client.callTool({
        name: 'get_ag_job',
        arguments: { workspaceRoot: tmpRoot },
      });
      const jobsData = JSON.parse(
        ((jobsCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; activeCount: number; jobs: unknown[] };
      expect(jobsData.ok).toBe(true);
      expect(jobsData.activeCount).toBe(0);
      expect(Array.isArray(jobsData.jobs)).toBe(true);

      const sessCall = await client.callTool({
        name: 'ag_session',
        arguments: { action: 'list', workspaceRoot: tmpRoot },
      });
      const sessData = JSON.parse(
        ((sessCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; sessions: unknown[] };
      expect(sessData.ok).toBe(true);
      expect(sessData.sessions).toEqual([]);

      const artCall = await client.callTool({
        name: 'list_ag_artifacts',
        arguments: { workspaceRoot: tmpRoot },
      });
      const artData = JSON.parse(
        ((artCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; artifacts: unknown[] };
      expect(artData.ok).toBe(true);
      expect(artData.artifacts).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('TC-I06: executes rollback_ag_task over live Stdio MCP and restores Git workspace', async () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(tmpRoot, 'index.ts'), 'export const ok = true;\n', 'utf8');
    git(['add', 'index.ts']);
    git(['commit', '-m', 'init']);

    // Pre-existing user untracked file + checkpoint
    fs.writeFileSync(path.join(tmpRoot, 'keep.txt'), 'preserve\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'ag-e2e-rb-1', 'best_effort');
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-e2e-rb-1',
      title: 'Live rollback test',
      mode: 'api',
      status: 'VERIFIED',
      lockedPaths: ['index.ts'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: cp.checkpointRef,
      gitCheckpointIsStash: cp.isStashSnapshot,
      gitUntrackedBaseline: cp.untrackedBaseline,
      artifacts: [],
    });

    // Simulate delegated edits
    fs.writeFileSync(path.join(tmpRoot, 'index.ts'), 'export const ok = false;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'temp-agent.ts'), 'export const x = 1;\n', 'utf8');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test-mcp-client-rb', version: '1.0.0' });
    await client.connect(transport);

    try {
      const rbCall = await client.callTool({
        name: 'rollback_ag_task',
        arguments: { taskId: 'ag-e2e-rb-1', workspaceRoot: tmpRoot },
      });
      const content = rbCall.content as Array<{ type: string; text?: string }>;
      const parsed = JSON.parse(content[0].text ?? '{}') as {
        ok: boolean;
        removedUntrackedFiles: string[];
        quarantineDir?: string;
        preRollbackHead?: string;
        preRollbackRef?: string;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.removedUntrackedFiles).toContain('temp-agent.ts');
      expect(fs.readFileSync(path.join(tmpRoot, 'index.ts'), 'utf8')).toBe('export const ok = true;\n');
      expect(fs.existsSync(path.join(tmpRoot, 'keep.txt'))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, 'temp-agent.ts'))).toBe(false);
      // the tool tells where the removed file went and how to undo the rollback (ARC-003 §5.5)
      expect(fs.existsSync(path.join(tmpRoot, parsed.quarantineDir ?? '-', 'removed', 'temp-agent.ts'))).toBe(true);
      expect(parsed.preRollbackHead).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.preRollbackRef).toBe('refs/ag-bridge/pre-rollback/ag-e2e-rb-1');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('TC-I07: returns structured isError responses over clean stdio for missing rollback & protected lockedPaths', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test-mcp-client-err', version: '1.0.0' });
    await client.connect(transport);

    try {
      const rbErr = await client.callTool({
        name: 'rollback_ag_task',
        arguments: { taskId: 'nonexistent-task', workspaceRoot: tmpRoot },
      });
      expect(rbErr.isError).toBe(true);
      const rbPayload = JSON.parse(
        ((rbErr.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; errorCode: string };
      expect(rbPayload.ok).toBe(false);
      expect(rbPayload.errorCode).toBe('ROLLBACK_NO_CHECKPOINT');

      const delErr = await client.callTool({
        name: 'delegate_to_antigravity',
        arguments: {
          title: 'Protected path attack',
          instructions: 'Attempt to lock .env for writing.',
          lockedPaths: ['.env'],
          acceptanceCriteria: ['Must be blocked'],
          workspaceRoot: tmpRoot,
        },
      });
      expect(delErr.isError).toBe(true);
      const delPayload = JSON.parse(
        ((delErr.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; errorCode: string };
      expect(delPayload.ok).toBe(false);
      expect(delPayload.errorCode).toBe('PROTECTED_PATH_BLOCKED');
    } finally {
      await client.close();
    }
  });

  it('TC-I08: aggregates current + archived token usage via get_ag_usage and exposes --dangerously-skip-permissions in list_ag_capabilities', async () => {
    archiveManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-usage-sub-1',
      title: 'Archived Subscription Task',
      mode: 'subscription',
      status: 'VERIFIED',
      lockedPaths: ['src/'],
      createdAt: '2026-11-23T01:00:00.000Z',
      updatedAt: '2026-11-23T01:01:00.000Z',
      artifacts: [],
      metrics: {
        model: 'gemini-4-neon-high',
        conversationId: 'conv-abc-123',
        durationSeconds: 12.5,
        numTurns: 3,
        permissionMode: 'always-proceed',
        usage: {
          inputTokens: 10000,
          outputTokens: 500,
          thinkingTokens: 200,
          cacheReadTokens: 4000,
          totalTokens: 10700,
        },
      },
    });
    writeManifest(tmpRoot, {
      schemaVersion: 1,
      taskId: 'ag-usage-api-2',
      title: 'Current API Task',
      mode: 'api',
      status: 'VERIFIED',
      lockedPaths: ['src/'],
      createdAt: '2026-11-23T02:00:00.000Z',
      updatedAt: '2026-11-23T02:01:00.000Z',
      artifacts: [],
      metrics: {
        model: 'gemini-2.5-pro',
        durationSeconds: 4.5,
        numTurns: 2,
        usage: {
          inputTokens: 2000,
          outputTokens: 300,
          thinkingTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 2300,
        },
      },
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test-mcp-client-usage', version: '1.1.0' });
    await client.connect(transport);
    try {
      const usageCall = await client.callTool({
        name: 'get_ag_usage',
        arguments: { workspaceRoot: tmpRoot },
      });
      const usage = JSON.parse(
        ((usageCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as {
        totalTasks: number;
        tasksWithUsage: number;
        totalDurationSeconds: number;
        totals: { inputTokens: number; outputTokens: number; totalTokens: number };
        byMode: { subscription: { tasks: number }; api: { tasks: number } };
      };

      expect(usage.totalTasks).toBe(2);
      expect(usage.tasksWithUsage).toBe(2);
      expect(usage.totalDurationSeconds).toBe(17);
      expect(usage.totals.inputTokens).toBe(12000);
      expect(usage.totals.outputTokens).toBe(800);
      expect(usage.totals.totalTokens).toBe(13000);
      expect(usage.byMode.subscription.tasks).toBe(1);
      expect(usage.byMode.api.tasks).toBe(1);

      const capCall = await client.callTool({
        name: 'list_ag_capabilities',
        arguments: { workspaceRoot: tmpRoot },
      });
      const cap = JSON.parse(
        ((capCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as {
        supportedFlags: string[];
        supportedPermissionModes: string[];
      };
      expect(cap.supportedFlags).toContain('--dangerously-skip-permissions');
      expect(cap.supportedFlags).toContain('--model');
      expect(cap.supportedFlags).toContain('--effort');
      expect(cap.supportedFlags).toContain('--conversation');
      expect(cap.supportedPermissionModes.some((m) => m.includes('--dangerously-skip-permissions'))).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  }, 20_000);

  it('TC-I09: streams notifications/progress over live Stdio MCP when client provides progressToken', async () => {
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fake-bin-'));
    const secretToken = ['AIza', 'SyProgressLeakCheck1234567890abcd'].join('');
    const fakeScript = path.join(fakeBinDir, 'fake-agy.mjs');
    fs.writeFileSync(
      fakeScript,
      [
        `const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');`,
        `emit({ event: 'init', conversation_id: 'conv-prog-1', init: { model: 'gemini-4-neon-high', permission_mode: 'accept-edits' } });`,
        `setTimeout(() => {`,
        `  emit({ event: 'step_update', step_update: { title: 'Inspecting layout with key ${secretToken}', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } } });`,
        `}, 40);`,
        `setTimeout(() => {`,
        `  emit({ event: 'result', result: { conversation_id: 'conv-prog-1', status: 'SUCCESS', response: 'Progress verified.', num_turns: 1, duration_seconds: 0.2, usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 } } });`,
        `}, 80);`,
      ].join('\n'),
      'utf8',
    );

    const isWin = process.platform === 'win32';
    const fakeAgyPath = path.join(fakeBinDir, isWin ? 'agy.cmd' : 'agy');
    if (isWin) {
      fs.writeFileSync(fakeAgyPath, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(fakeAgyPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, {
        mode: 0o755,
      });
    }

    // Untracked workspace config pointing app_path to fakeAgyPath outside tmpRoot (passes TC-S17)
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.ag-bridge', 'config.json'),
      JSON.stringify({
        execution_mode: 'subscription',
        subscription: {
          app_path: fakeAgyPath,
          trigger_method: 'cli_only',
          poll_interval_ms: 100,
          agy_stream_heartbeat: true,
        },
      }),
      'utf8',
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test-mcp-client-progress', version: '1.5.0' });
    await client.connect(transport);

    const received: Array<{ progress: number; total?: number; message?: string }> = [];
    try {
      const delCall = await client.callTool(
        {
          name: 'delegate_to_antigravity',
          arguments: {
            title: 'Live MCP progress streaming test',
            instructions: 'Verify notifications/progress streaming.',
            modeOverride: 'subscription',
            disableSlashCommands: true,
            workspaceRoot: tmpRoot,
          },
        },
        undefined,
        {
          onprogress: (p) => {
            received.push({ progress: p.progress, total: p.total, message: p.message });
          },
        },
      );

      const parsed = JSON.parse(
        ((delCall.content as Array<{ text?: string }>)[0]?.text) ?? '{}',
      ) as { ok: boolean; status: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe('VERIFIED');

      // Expect dispatch (0), init (1), step_update (2), result (3)
      expect(received.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < received.length; i++) {
        expect(received[i].progress).toBeGreaterThanOrEqual(received[i - 1].progress);
      }
      const joined = received.map((r) => r.message ?? '').join('\n');
      expect(joined).toContain('session initialized');
      expect(joined).toContain('[REDACTED]');
      expect(joined).not.toContain(secretToken);
      expect(joined).toContain('Antigravity finished');
    } finally {
      await client.close();
      fs.rmSync(fakeBinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
