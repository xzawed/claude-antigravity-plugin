#!/usr/bin/env node
/**
 * Self-contained bundle smoke test — what a marketplace install actually gets.
 *
 * `/plugin install` copies the repository as committed: it never runs `npm install` or
 * `npm run build`. So the two entry points that `.mcp.json` and `hooks/hooks.json` launch
 * must be committed AND must run with no `node_modules` anywhere. This script uses Node
 * built-ins only, so it can run before `npm ci` (CI does exactly that) or from a
 * `git archive` extraction.
 *
 *   1. server/dist/index.js and server/dist/cli-init.js exist
 *   2. both bundles reference only Node built-ins (static scan — see bundle-scan.mjs for why
 *      starting them is not enough on its own)
 *   3. the MCP server answers `initialize` + `tools/list` over stdio (12 tools)
 *   4. cli-init initializes a workspace whose path contains spaces
 * Steps 3–4 run with NODE_PATH removed from the environment.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBundle } from './bundle-scan.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(serverDir, 'dist', 'index.js');
const distInit = path.join(serverDir, 'dist', 'cli-init.js');

// A createRequire-based require() searches NODE_PATH; don't let it supply a missing dependency.
const hermeticEnv = { ...process.env };
delete hermeticEnv.NODE_PATH;

const EXPECTED_TOOLS = [
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
];

// Sets the exit code instead of exiting, so `finally` blocks still remove temp directories.
function fail(message) {
  console.error(`[smoke-bundle] FAIL: ${message}`);
  process.exitCode = 1;
}

function mcpHandshake(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex], {
      cwd,
      env: hermeticEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((res) => child.once('exit', res));
    // Settle only after the child has exited: Windows refuses to remove a directory that is
    // still some process's working directory (EBUSY).
    const settle = (fn, value) => {
      clearTimeout(timer);
      child.kill();
      exited.then(() => fn(value));
    };
    let stdoutBuf = '';
    let stderrBuf = '';
    const pending = new Map();
    const timer = setTimeout(() => {
      settle(reject, new Error(`MCP server did not answer within 20 s. stderr:\n${stderrBuf}`));
    }, 20_000);
    child.on('error', (err) => settle(reject, err));
    // A server that dies early turns our next write into EPIPE; the 'exit' handler reports it.
    child.stdin.on('error', () => {});

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const request = (id, method, params) =>
      new Promise((res) => {
        pending.set(id, res);
        send({ jsonrpc: '2.0', id, method, params });
      });

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // stdout is reserved for JSON-RPC frames (AGENTS.md invariant 4)
          settle(reject, new Error(`Non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        const res = pending.get(msg.id);
        if (res) {
          pending.delete(msg.id);
          res(msg);
        }
      }
    });
    child.on('exit', (code) => {
      if (pending.size > 0) {
        settle(reject, new Error(`MCP server exited early (code ${code}). stderr:\n${stderrBuf}`));
      }
    });

    (async () => {
      const init = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-bundle', version: '1.0.0' },
      });
      if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await request(2, 'tools/list', {});
      if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
      settle(resolve, {
        serverInfo: init.result?.serverInfo,
        tools: (list.result?.tools ?? []).map((t) => t.name).sort(),
      });
    })().catch((err) => settle(reject, err));
  });
}

async function main() {
  for (const file of [distIndex, distInit]) {
    if (!fs.existsSync(file)) {
      return fail(`${path.relative(serverDir, file)} is not in the tree — marketplace installs would ship no runnable server`);
    }
  }
  console.log('[smoke-bundle] 1/4 OK: dist/index.js and dist/cli-init.js are present');

  for (const file of [distIndex, distInit]) {
    const problems = scanBundle(fs.readFileSync(file, 'utf8'));
    if (problems.length > 0) {
      return fail(`${path.relative(serverDir, file)} is not self-contained: ${problems.join('; ')}`);
    }
  }
  console.log('[smoke-bundle] 2/4 OK: both bundles reference only Node built-ins');

  const mcpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ag smoke mcp '));
  try {
    const { serverInfo, tools } = await mcpHandshake(mcpCwd);
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`unexpected MCP tool list: ${tools.join(', ')}`);
    }
    console.log(`[smoke-bundle] 3/4 OK: ${serverInfo?.name ?? 'server'} ${serverInfo?.version ?? ''} answered tools/list (${tools.length} tools)`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    fs.rmSync(mcpCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ag smoke init '));
  try {
    // Without --silent, an initialization error exits non-zero instead of being swallowed.
    execFileSync(process.execPath, [distInit, '--workspace', workspace], { stdio: 'inherit', env: hermeticEnv });
    for (const rel of ['.ag-bridge/config.json', '.agent/workflows/claude-handoff.md']) {
      if (!fs.existsSync(path.join(workspace, rel))) throw new Error(`cli-init did not create ${rel}`);
    }
    console.log('[smoke-bundle] 4/4 OK: cli-init initialized a workspace path containing spaces');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log('[smoke-bundle] PASS: the committed bundle runs with no node_modules');
}

await main();
