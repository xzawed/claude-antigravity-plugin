import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, maskSecrets } from './config.js';
import { detectEnvironment, DetectorDeps, getDefaultDetectorDeps } from './detector.js';
import { buildCliSpawnSpec, killChildProcessTree } from './engines/subscription.js';
import { AgCliAdminToolInput, AgCliAdminToolOutput } from './types.js';

export type AdminRunnerFn = (
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform,
  timeoutMs: number,
  cwd?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface CliAdminDependencies {
  detectorDeps?: DetectorDeps;
  runCliFn?: AdminRunnerFn;
}

// Must start with an alphanumeric character so server names can never be parsed as CLI flags (`--all`, `-t`, `.`, `..`).
const VALID_SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_ENV_KV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VALID_HEADER_RE = /^[A-Za-z0-9-]+:/;
const CONTROL_CHAR_RE = /[\r\n\0]/;
const MAX_ADMIN_OUTPUT_BYTES = 2 * 1024 * 1024;

function extractSecretValues(envVars?: string[], headers?: string[]): string[] {
  const secrets: string[] = [];
  for (const kv of envVars ?? []) {
    const eq = kv.indexOf('=');
    if (eq > 0) {
      const val = kv.slice(eq + 1).trim();
      if (val.length >= 4) secrets.push(val);
    }
  }
  for (const h of headers ?? []) {
    const colon = h.indexOf(':');
    if (colon > 0) {
      const val = h.slice(colon + 1).trim();
      if (val.length >= 4) secrets.push(val);
    }
  }
  return secrets;
}

function hasControlChars(values: Array<string | undefined>): boolean {
  return values.some((v) => typeof v === 'string' && CONTROL_CHAR_RE.test(v));
}

export function defaultRunAdminCli(
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform,
  timeoutMs: number,
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const spec = buildCliSpawnSpec(cliPath, args, platform);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (res: { exitCode: number; stdout: string; stderr: string }): void => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    try {
      const child = spawn(spec.command, spec.args, {
        ...(cwd ? { cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        shell: false,
        windowsHide: spec.windowsHide,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });

      const timer = setTimeout(() => {
        killChildProcessTree(child, platform);
        finish({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms.` });
      }, timeoutMs);

      child.stdout?.on('data', (c: Buffer | string) => {
        if (stdout.length < MAX_ADMIN_OUTPUT_BYTES) {
          stdout += typeof c === 'string' ? c : c.toString('utf8');
        }
      });
      child.stderr?.on('data', (c: Buffer | string) => {
        if (stderr.length < MAX_ADMIN_OUTPUT_BYTES) {
          stderr += typeof c === 'string' ? c : c.toString('utf8');
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        finish({ exitCode: 1, stdout, stderr: err.message });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        finish({ exitCode: code ?? 1, stdout, stderr });
      });
    } catch (err) {
      finish({
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function formatRedactedCliArgs(args: string[]): string {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--env' || arg === '--header') && i + 1 < args.length) {
      redacted.push(arg);
      const next = args[i + 1];
      if (arg === '--env') {
        const eqIdx = next.indexOf('=');
        redacted.push(eqIdx > 0 ? `${next.slice(0, eqIdx)}=[REDACTED]` : '[REDACTED]');
      } else {
        const colonIdx = next.indexOf(':');
        redacted.push(colonIdx > 0 ? `${next.slice(0, colonIdx)}: [REDACTED]` : '[REDACTED]');
      }
      i += 1;
    } else {
      redacted.push(arg);
    }
  }
  return maskSecrets(redacted.join(' '));
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n\n[... truncated ${lines.length - maxLines} additional lines ...]`;
}

export function buildMcpAddArgs(input: {
  name: string;
  commandOrUrl: string;
  args?: string[];
  serverType?: 'stdio' | 'http';
  envVars?: string[];
  headers?: string[];
}): string[] {
  const cliArgs: string[] = ['mcp', 'add'];
  if (input.serverType) {
    cliArgs.push('--type', input.serverType);
  }
  if (input.envVars) {
    for (const kv of input.envVars) {
      cliArgs.push('--env', kv);
    }
  }
  if (input.headers) {
    for (const h of input.headers) {
      cliArgs.push('--header', h);
    }
  }
  cliArgs.push(input.name);
  const extraArgs = input.args ?? [];
  const needsSeparator =
    input.commandOrUrl.startsWith('-') || extraArgs.some((a) => a.startsWith('-'));
  if (needsSeparator) {
    cliArgs.push('--');
  }
  cliArgs.push(input.commandOrUrl, ...extraArgs);
  return cliArgs;
}

export async function handleAgCliAdmin(
  input: AgCliAdminToolInput,
  deps: CliAdminDependencies = {},
): Promise<AgCliAdminToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const detDeps = deps.detectorDeps ?? getDefaultDetectorDeps();
  const config = loadConfig(workspaceRoot, detDeps.env);
  const detection = detectEnvironment(config, undefined, detDeps);
  const warnings: string[] = [];

  if (
    !detection.subscription.detected ||
    detection.subscription.cliBinary !== 'agy' ||
    !detection.subscription.cliPath
  ) {
    return {
      ok: false,
      action: input.action,
      output: '',
      warnings,
      errorCode: 'AGY_CLI_NOT_FOUND',
      errorMessage: 'Antigravity CLI (`agy`) was not detected. Install `agy` first.',
    };
  }

  const cliPath = detection.subscription.cliPath;
  const runCli = deps.runCliFn ?? defaultRunAdminCli;

  // Special workflow: sync Claude Code's workspace .mcp.json servers into `agy mcp`
  if (input.action === 'mcp_sync_from_claude') {
    const mcpJsonPath = path.join(workspaceRoot, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) {
      return {
        ok: false,
        action: input.action,
        cliPath,
        output: '',
        warnings,
        errorCode: 'CLI_ADMIN_FAILED',
        errorMessage: `No \`.mcp.json\` found in workspace root: ${workspaceRoot}`,
      };
    }

    let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
    } catch (err) {
      return {
        ok: false,
        action: input.action,
        cliPath,
        output: '',
        warnings,
        errorCode: 'CLI_ADMIN_FAILED',
        errorMessage: `Failed to parse .mcp.json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const servers =
      parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
        ? parsed.mcpServers
        : {};
    const dryRun = input.dryRun ?? true;
    const syncedServers: NonNullable<AgCliAdminToolOutput['syncedServers']> = [];

    for (const [name, rawDef] of Object.entries(servers)) {
      if (name === 'antigravity-delegate') {
        syncedServers.push({
          name,
          status: 'skipped',
          detail: 'Skipped self-registration to prevent recursive delegation loops.',
        });
        continue;
      }
      if (!VALID_SERVER_NAME_RE.test(name)) {
        syncedServers.push({ name, status: 'skipped', detail: 'Invalid MCP server name.' });
        continue;
      }
      if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) {
        syncedServers.push({ name, status: 'skipped', detail: 'Invalid MCP server definition.' });
        continue;
      }
      const def = rawDef as Record<string, unknown>;

      const command = typeof def.command === 'string' ? def.command : undefined;
      const url = typeof def.url === 'string' ? def.url : undefined;
      const commandOrUrl = command ?? url;
      if (!commandOrUrl) {
        syncedServers.push({ name, status: 'skipped', detail: 'Missing command or url.' });
        continue;
      }

      const args = Array.isArray(def.args)
        ? def.args.filter((a): a is string => typeof a === 'string')
        : [];
      const envObj =
        def.env && typeof def.env === 'object' && !Array.isArray(def.env)
          ? (def.env as Record<string, unknown>)
          : {};
      const envVars = Object.entries(envObj)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}=${v}`);

      const headersObj =
        def.headers && typeof def.headers === 'object' && !Array.isArray(def.headers)
          ? (def.headers as Record<string, unknown>)
          : {};
      const headers = Object.entries(headersObj)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}: ${v}`);

      if (hasControlChars([commandOrUrl, ...args, ...envVars, ...headers])) {
        syncedServers.push({
          name,
          status: 'skipped',
          detail: 'Skipped: contains disallowed control characters (CR/LF/NUL).',
        });
        continue;
      }

      const addArgs = buildMcpAddArgs({
        name,
        commandOrUrl,
        args,
        serverType: command ? 'stdio' : 'http',
        envVars,
        headers,
      });

      if (dryRun) {
        syncedServers.push({
          name,
          status: 'planned',
          detail: `agy ${formatRedactedCliArgs(addArgs)}`,
        });
      } else {
        const res = await runCli(cliPath, addArgs, detection.platform, 20_000, workspaceRoot);
        const extraSecrets = extractSecretValues(envVars, headers);
        syncedServers.push({
          name,
          status: res.exitCode === 0 ? 'synced' : 'failed',
          detail: maskSecrets((res.stdout || res.stderr).trim() || `exit ${res.exitCode}`, extraSecrets),
        });
      }
    }

    const failedCount = syncedServers.filter((s) => s.status === 'failed').length;
    const summary = syncedServers
      .map((s) => `- ${s.name}: [${s.status}] ${s.detail}`)
      .join('\n');
    return {
      ok: dryRun || failedCount === 0,
      action: input.action,
      cliPath,
      output: dryRun
        ? `Dry-run sync plan from .mcp.json (re-run with dryRun=false to apply):\n${summary || '(No eligible MCP servers found.)'}`
        : `Sync results from .mcp.json:\n${summary || '(No eligible MCP servers found.)'}`,
      syncedServers,
      warnings,
      errorCode: !dryRun && failedCount > 0 ? 'CLI_ADMIN_FAILED' : undefined,
      errorMessage:
        !dryRun && failedCount > 0
          ? `${failedCount} MCP server(s) failed to sync from .mcp.json.`
          : undefined,
    };
  }

  let cliArgs: string[] = [];
  let timeoutMs = 20_000;

  switch (input.action) {
    case 'mcp_list':
      cliArgs = ['mcp', 'list'];
      break;
    case 'mcp_add': {
      if (!input.name || !VALID_SERVER_NAME_RE.test(input.name)) {
        return {
          ok: false,
          action: input.action,
          cliPath,
          output: '',
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: 'Valid `name` (alphanumeric, `_`, `-`, `.`) is required for `mcp_add`.',
        };
      }
      if (!input.commandOrUrl) {
        return {
          ok: false,
          action: input.action,
          cliPath,
          output: '',
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: '`commandOrUrl` is required for `mcp_add`.',
        };
      }
      if (
        hasControlChars([
          input.commandOrUrl,
          ...(input.args ?? []),
          ...(input.envVars ?? []),
          ...(input.headers ?? []),
        ])
      ) {
        return {
          ok: false,
          action: input.action,
          cliPath,
          output: '',
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: 'Control characters (CR/LF/NUL) are not allowed in `mcp_add` arguments, envVars, or headers.',
        };
      }
      if (
        (input.envVars ?? []).some((kv) => !VALID_ENV_KV_RE.test(kv)) ||
        (input.headers ?? []).some((h) => !VALID_HEADER_RE.test(h))
      ) {
        return {
          ok: false,
          action: input.action,
          cliPath,
          output: '',
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: 'Invalid `envVars` (expected KEY=VALUE) or `headers` (expected Name: Value) format in `mcp_add`.',
        };
      }
      cliArgs = buildMcpAddArgs({
        name: input.name,
        commandOrUrl: input.commandOrUrl,
        args: input.args,
        serverType: input.serverType,
        envVars: input.envVars,
        headers: input.headers,
      });
      break;
    }
    case 'mcp_remove':
    case 'mcp_enable':
    case 'mcp_disable': {
      if (!input.name || !VALID_SERVER_NAME_RE.test(input.name)) {
        return {
          ok: false,
          action: input.action,
          cliPath,
          output: '',
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: `Valid \`name\` is required for \`${input.action}\`.`,
        };
      }
      const sub = input.action.replace('mcp_', '');
      cliArgs = ['mcp', sub, input.name];
      break;
    }
    case 'remote_status':
      cliArgs = ['remote-control', 'status'];
      break;
    case 'remote_start':
      cliArgs = ['remote-control', 'start'];
      timeoutMs = 30_000;
      break;
    case 'remote_stop':
      cliArgs = ['remote-control', 'stop'];
      timeoutMs = 30_000;
      break;
    case 'changelog':
      cliArgs = ['changelog'];
      break;
    case 'update':
      cliArgs = ['update'];
      timeoutMs = 60_000;
      break;
  }

  const res = await runCli(cliPath, cliArgs, detection.platform, timeoutMs, workspaceRoot);
  const extraSecrets =
    input.action === 'mcp_add' ? extractSecretValues(input.envVars, input.headers) : [];
  const combined = maskSecrets(
    [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n'),
    extraSecrets,
  );
  const maxLines = Math.min(300, Math.max(10, input.maxLines ?? 80));
  const output = truncateLines(combined, maxLines);

  return {
    ok: res.exitCode === 0,
    action: input.action,
    cliPath,
    exitCode: res.exitCode,
    output,
    warnings,
    errorCode: res.exitCode === 0 ? undefined : 'CLI_ADMIN_FAILED',
    errorMessage:
      res.exitCode === 0
        ? undefined
        : `\`agy ${formatRedactedCliArgs(cliArgs)}\` exited with code ${res.exitCode}.`,
  };
}
