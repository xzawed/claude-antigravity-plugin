import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('MCP Stdio protocol integration (TC-I01)', () => {
  let tmpRoot: string;
  const distIndex = path.resolve(import.meta.dirname, '..', 'dist', 'index.js');

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mcp-stdio-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-I01: exposes all 3 MCP tools over clean stdio JSON-RPC and executes check_ag_environment', async () => {
    if (!fs.existsSync(distIndex)) {
      throw new Error(`Built server not found at ${distIndex}. Run "npm run build" before tests.`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndex],
      cwd: tmpRoot,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(transport);

    try {
      const toolsRes = await client.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'check_ag_environment',
        'delegate_to_antigravity',
        'rollback_ag_task',
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
    } finally {
      await client.close();
    }
  });
});
