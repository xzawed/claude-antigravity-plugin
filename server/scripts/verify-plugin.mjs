#!/usr/bin/env node
/**
 * Live plugin healthcheck & Stdio MCP smoke verification script.
 * Runs manifest validation, space-path cli-init check, and live MCP JSON-RPC
 * handshake (`tools/list` + `check_ag_environment`) against the built server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const serverDir = path.resolve(path.dirname(__filename), '..');
const pluginRoot = path.resolve(serverDir, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Verification failed: ${message}`);
  }
}

async function main() {
  console.log('[verify] 1/3 Checking plugin manifests & built artifacts...');
  for (const rel of [
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'hooks/hooks.json',
    'server/package.json',
    'server/tsconfig.json',
  ]) {
    const abs = path.join(pluginRoot, rel);
    assert(fs.existsSync(abs), `Missing file ${rel}`);
    JSON.parse(fs.readFileSync(abs, 'utf8'));
  }

  const distIndex = path.join(serverDir, 'dist', 'index.js');
  const distInit = path.join(serverDir, 'dist', 'cli-init.js');
  assert(fs.existsSync(distIndex), 'Missing server/dist/index.js (run `npm run build` first)');
  assert(fs.existsSync(distInit), 'Missing server/dist/cli-init.js (run `npm run build` first)');
  console.log('  OK: All 5 manifests and built entrypoints verified.');

  console.log('[verify] 2/3 Running space-path SessionStart hook smoke test...');
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag plugin live verify '));
  try {
    execFileSync(process.execPath, [distInit, '--silent', '--workspace', smokeDir], {
      stdio: 'inherit',
    });
    for (const rel of [
      '.ag-bridge/config.json',
      '.gitignore',
      '.agent/workflows/claude-handoff.md',
    ]) {
      assert(fs.existsSync(path.join(smokeDir, rel)), `cli-init did not create ${rel}`);
    }
    console.log(`  OK: cli-init --silent succeeded in "${smokeDir}".`);
  } finally {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }

  console.log('[verify] 3/3 Running live MCP Stdio handshake & environment check...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndex],
    cwd: pluginRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'antigravity-plugin-verifier', version: '1.0.0' });
  await client.connect(transport);
  try {
    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name).sort();
    assert(
      JSON.stringify(names) ===
        JSON.stringify(['check_ag_environment', 'delegate_to_antigravity', 'rollback_ag_task']),
      `Unexpected MCP tool list: ${names.join(', ')}`,
    );

    const envRes = await client.callTool({
      name: 'check_ag_environment',
      arguments: { workspaceRoot: pluginRoot },
    });
    const text = envRes.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);
    console.log('  OK: MCP Stdio tools:', names.join(', '));
    console.log(
      `  OK: Live environment -> configured=${parsed.configuredMode}, resolved=${parsed.resolvedMode}, cli=${parsed.subscription?.cliBinary ?? 'none'} (${parsed.subscription?.cliPath ?? 'n/a'}), apiConfigured=${parsed.api?.configured}, gitRepo=${parsed.git?.isGitRepo}`,
    );
  } finally {
    await client.close();
  }

  console.log('[verify] ALL LIVE VERIFICATION CHECKS PASSED.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
