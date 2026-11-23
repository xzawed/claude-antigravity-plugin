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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-I01: exposes all 9 MCP tools over clean stdio JSON-RPC and executes check_ag_environment + ag_auth + get_ag_job', async () => {
    if (!fs.existsSync(distIndex)) {
      throw new Error(`Built server not found at ${distIndex}. Run "npm run build" before tests.`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'test-mcp-client', version: '1.3.0' });
    await client.connect(transport);

    try {
      const toolsRes = await client.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'ag_auth',
        'cancel_ag_job',
        'check_ag_environment',
        'delegate_to_antigravity',
        'get_ag_job',
        'get_ag_usage',
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
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.removedUntrackedFiles).toContain('temp-agent.ts');
      expect(fs.readFileSync(path.join(tmpRoot, 'index.ts'), 'utf8')).toBe('export const ok = true;\n');
      expect(fs.existsSync(path.join(tmpRoot, 'keep.txt'))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, 'temp-agent.ts'))).toBe(false);
    } finally {
      await client.close();
    }
  });

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
});
