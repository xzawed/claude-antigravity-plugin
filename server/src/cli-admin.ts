import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, maskSecrets } from './config.js';
import { detectEnvironment, DetectorDeps, getDefaultDetectorDeps } from './detector.js';
import { buildCliSpawnSpec, killChildProcessTree } from './engines/subscription.js';
import { GitPullResult, pullFastForwardRepo } from './git-guard.js';
import {
  AgCliAdminToolInput,
  AgCliAdminToolOutput,
  PluginInstallMethod,
  PluginUpdateInfo,
} from './types.js';

export type AdminRunnerFn = (
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform,
  timeoutMs: number,
  cwd?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface LatestReleaseInfo {
  version: string;
  releaseUrl?: string;
}

export interface CliAdminDependencies {
  pluginRoot?: string;
  detectorDeps?: DetectorDeps;
  runCliFn?: AdminRunnerFn;
  fetchLatestReleaseFn?: () => Promise<LatestReleaseInfo | null>;
  pullRepoFn?: (repoDir: string) => GitPullResult;
}

export const PLUGIN_GITHUB_REPO = 'xzawed/claude-antigravity-plugin';
export const PLUGIN_MARKETPLACE_NAME = 'claude-antigravity-plugin';
export const PLUGIN_MARKETPLACE_ID = 'antigravity-delegate@claude-antigravity-plugin';
const PLUGIN_RELEASES_API_URL = `https://api.github.com/repos/${PLUGIN_GITHUB_REPO}/releases/latest`;
const SEMVER_CORE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

function getDefaultPluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_CORE_RE.exec(a.trim().replace(/^v/i, ''));
  const mb = SEMVER_CORE_RE.exec(b.trim().replace(/^v/i, ''));
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da < db ? -1 : 1;
  }
  const preA = ma[4];
  const preB = mb[4];
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA.localeCompare(preB);
}

export function detectPluginInstallMethod(pluginRoot: string): PluginInstallMethod {
  const normalized = path.resolve(pluginRoot).replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.claude/plugins/cache/')) {
    return 'marketplace';
  }
  if (fs.existsSync(path.join(pluginRoot, '.git'))) {
    return 'git_clone';
  }
  return 'unknown';
}

export function readInstalledPluginVersion(pluginRoot: string): string {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.trim().length > 0) {
      return raw.version.trim();
    }
  } catch {
    // fallback below
  }
  return 'unknown';
}

export async function fetchLatestPluginRelease(timeoutMs = 2500): Promise<LatestReleaseInfo | null> {
  try {
    const res = await fetch(PLUGIN_RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'claude-antigravity-plugin',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof data.tag_name !== 'string') return null;
    const version = data.tag_name.trim().replace(/^v/i, '');
    if (!SEMVER_CORE_RE.test(version)) return null;
    const releaseUrl = typeof data.html_url === 'string' ? data.html_url : undefined;
    return { version, releaseUrl };
  } catch {
    return null;
  }
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
  const warnings: string[] = [];
  const runCli = deps.runCliFn ?? defaultRunAdminCli;

  // Plugin self-update & version check do not require `agy` CLI (works in API-only mode too)
  if (input.action === 'plugin_status' || input.action === 'plugin_update') {
    const pluginRoot = path.resolve(deps.pluginRoot ?? getDefaultPluginRoot());
    const currentVersion = readInstalledPluginVersion(pluginRoot);
    const installMethod = detectPluginInstallMethod(pluginRoot);
    const fetchLatest = deps.fetchLatestReleaseFn ?? fetchLatestPluginRelease;

    if (input.action === 'plugin_status') {
      const latest = await fetchLatest();
      const updateAvailable =
        latest && currentVersion !== 'unknown'
          ? compareSemver(currentVersion, latest.version) < 0
          : undefined;

      const nextSteps: string[] = [];
      if (updateAvailable) {
        nextSteps.push('Run `/ag-update plugin` to update the plugin now, then `/reload-plugins`.');
      } else if (latest) {
        nextSteps.push('Plugin is already up to date.');
      } else {
        warnings.push('Could not reach GitHub Releases API to check the latest version (offline or rate-limited).');
        nextSteps.push('Run `/ag-update plugin` when online to pull the latest release.');
      }

      if (installMethod === 'marketplace') {
        nextSteps.push(
          'Tip (Zero-Touch Auto-Update): In Claude Code, run `/plugin` -> Marketplaces -> `claude-antigravity-plugin` -> Enable auto-update.',
        );
      } else if (installMethod === 'git_clone') {
        nextSteps.push(
          'Tip: Prebuilt server bundles are committed, so `/ag-update plugin` (or `git pull --ff-only` + `/reload-plugins`) updates without running `npm install` or `npm run build`.',
        );
      } else {
        nextSteps.push(
          `Switch to GitHub Marketplace for 1-click & automatic updates: \`/plugin marketplace add ${PLUGIN_GITHUB_REPO}\` then \`/plugin install ${PLUGIN_MARKETPLACE_ID}\`.`,
        );
      }

      const pluginUpdate: PluginUpdateInfo = {
        currentVersion,
        latestVersion: latest?.version,
        updateAvailable,
        installMethod,
        pluginRoot,
        releaseUrl: latest?.releaseUrl,
        nextSteps,
      };

      const statusLine =
        updateAvailable === true
          ? `Update available: v${currentVersion} -> v${latest?.version}`
          : updateAvailable === false
            ? `Up to date (v${currentVersion})`
            : `Installed: v${currentVersion} (latest release check unavailable)`;

      const output = [
        `claude-antigravity-plugin status: ${statusLine}`,
        `- Install method: ${installMethod}`,
        `- Plugin root: ${pluginRoot}`,
        ...(latest?.releaseUrl ? [`- Latest release: ${latest.releaseUrl}`] : []),
        '',
        ...nextSteps.map((s) => `- ${s}`),
      ].join('\n');

      return {
        ok: true,
        action: input.action,
        output,
        pluginUpdate,
        warnings,
      };
    }

    // input.action === 'plugin_update'
    const dryRun = input.dryRun ?? false;

    if (installMethod === 'marketplace') {
      const mktArgs = ['plugin', 'marketplace', 'update', PLUGIN_MARKETPLACE_NAME];
      const updArgs = ['plugin', 'update', PLUGIN_MARKETPLACE_ID];
      if (dryRun) {
        const nextSteps = [
          'Re-run `/ag-update plugin` (without dry-run) to execute both commands.',
          'Then run `/reload-plugins` in Claude Code.',
        ];
        return {
          ok: true,
          action: input.action,
          output: `Dry-run plugin update plan (marketplace):\n- claude ${mktArgs.join(' ')}\n- claude ${updArgs.join(' ')}`,
          pluginUpdate: {
            currentVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps,
          },
          warnings,
        };
      }

      const claudePath = detDeps.findBinary('claude');
      if (!claudePath) {
        const nextSteps = [
          `Run inside Claude Code: \`/plugin marketplace update ${PLUGIN_MARKETPLACE_NAME}\``,
          `Then run: \`/plugin update ${PLUGIN_MARKETPLACE_ID}\``,
          'Finally run `/reload-plugins` (or restart Claude Code).',
        ];
        return {
          ok: false,
          action: input.action,
          output: nextSteps.join('\n'),
          pluginUpdate: {
            currentVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps,
          },
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: '`claude` CLI was not found on PATH to run automatic marketplace update.',
        };
      }

      const step1 = await runCli(claudePath, mktArgs, detDeps.platform, 45_000, workspaceRoot);
      const step1Out = maskSecrets([step1.stdout.trim(), step1.stderr.trim()].filter(Boolean).join('\n'));
      if (step1.exitCode !== 0) {
        const nextSteps = [
          `Try running directly: \`claude ${mktArgs.join(' ')}\``,
          `Or inside Claude Code: \`/plugin marketplace update ${PLUGIN_MARKETPLACE_NAME}\``,
        ];
        return {
          ok: false,
          action: input.action,
          cliPath: claudePath,
          exitCode: step1.exitCode,
          output: step1Out || `Failed to refresh marketplace (exit ${step1.exitCode}).`,
          pluginUpdate: {
            currentVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps,
          },
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: `\`claude ${mktArgs.join(' ')}\` exited with code ${step1.exitCode}.`,
        };
      }

      const step2 = await runCli(claudePath, updArgs, detDeps.platform, 45_000, workspaceRoot);
      const step2Out = maskSecrets([step2.stdout.trim(), step2.stderr.trim()].filter(Boolean).join('\n'));
      const combinedOut = [step1Out, step2Out].filter(Boolean).join('\n');

      if (step2.exitCode !== 0) {
        const nextSteps = [
          `Try running directly: \`claude ${updArgs.join(' ')}\``,
          `Or inside Claude Code: \`/plugin update ${PLUGIN_MARKETPLACE_ID}\``,
        ];
        return {
          ok: false,
          action: input.action,
          cliPath: claudePath,
          exitCode: step2.exitCode,
          output: combinedOut || `Plugin update failed (exit ${step2.exitCode}).`,
          pluginUpdate: {
            currentVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps,
          },
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: `\`claude ${updArgs.join(' ')}\` exited with code ${step2.exitCode}.`,
        };
      }

      const alreadyLatest = /already\s+(?:at\s+the\s+)?latest|up\s+to\s+date/i.test(step2Out);
      const nextSteps = alreadyLatest
        ? [
            'Plugin is already on the latest marketplace release.',
            'Tip: Enable automatic updates once via `/plugin` -> Marketplaces -> `claude-antigravity-plugin` -> Enable auto-update.',
          ]
        : [
            'Run `/reload-plugins` in Claude Code (or restart Claude Code) to activate the new version.',
            'Tip: Enable automatic updates once via `/plugin` -> Marketplaces -> `claude-antigravity-plugin` -> Enable auto-update.',
          ];

      return {
        ok: true,
        action: input.action,
        cliPath: claudePath,
        exitCode: 0,
        output: combinedOut || 'Marketplace refreshed and plugin updated successfully.',
        pluginUpdate: {
          currentVersion,
          installMethod,
          pluginRoot,
          updated: !alreadyLatest,
          reloadRequired: !alreadyLatest,
          nextSteps,
        },
        warnings,
      };
    }

    if (installMethod === 'git_clone') {
      if (dryRun) {
        return {
          ok: true,
          action: input.action,
          output: `Dry-run plugin update plan (git_clone):\n- git -C "${pluginRoot}" pull --ff-only\n(Prebuilt bundles in server/dist/ are committed; no npm install or build required.)`,
          pluginUpdate: {
            currentVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps: ['Re-run `/ag-update plugin` (without dry-run) to pull updates, then `/reload-plugins`.'],
          },
          warnings,
        };
      }

      const pullFn = deps.pullRepoFn ?? pullFastForwardRepo;
      const pullRes = pullFn(pluginRoot);
      const updatedVersion = readInstalledPluginVersion(pluginRoot);

      if (!pullRes.ok) {
        return {
          ok: false,
          action: input.action,
          output: maskSecrets(pullRes.output || pullRes.error || 'git pull --ff-only failed.'),
          pluginUpdate: {
            currentVersion: updatedVersion,
            installMethod,
            pluginRoot,
            updated: false,
            reloadRequired: false,
            nextSteps: [
              `Inspect local git status in "${pluginRoot}" and run \`git -C "${pluginRoot}" pull --ff-only\`.`,
            ],
          },
          warnings,
          errorCode: 'CLI_ADMIN_FAILED',
          errorMessage: maskSecrets(pullRes.error ?? 'Failed to fast-forward local plugin repository.'),
        };
      }

      const updated = !pullRes.alreadyUpToDate;
      const nextSteps = updated
        ? [
            `Updated local checkout (${pullRes.previousHead ?? '?'} -> ${pullRes.currentHead ?? '?'}, v${currentVersion} -> v${updatedVersion}).`,
            'Run `/reload-plugins` in Claude Code to activate the updated version immediately (no `npm install` or `build` needed).',
          ]
        : ['Local plugin checkout is already up to date.'];

      return {
        ok: true,
        action: input.action,
        exitCode: 0,
        output: maskSecrets(pullRes.output),
        pluginUpdate: {
          currentVersion: updatedVersion,
          installMethod,
          pluginRoot,
          updated,
          reloadRequired: updated,
          nextSteps,
        },
        warnings,
      };
    }

    const unknownNextSteps = [
      `Install via GitHub Marketplace for 1-click & automatic updates:`,
      `  1. /plugin marketplace add ${PLUGIN_GITHUB_REPO}`,
      `  2. /plugin install ${PLUGIN_MARKETPLACE_ID}`,
      '  3. Optional: /plugin -> Marketplaces -> claude-antigravity-plugin -> Enable auto-update',
    ];
    return {
      ok: false,
      action: input.action,
      output: unknownNextSteps.join('\n'),
      pluginUpdate: {
        currentVersion,
        installMethod,
        pluginRoot,
        updated: false,
        reloadRequired: false,
        nextSteps: unknownNextSteps,
      },
      warnings,
      errorCode: 'CLI_ADMIN_FAILED',
      errorMessage: `Plugin directory "${pluginRoot}" is neither a Claude marketplace cache nor a git clone.`,
    };
  }

  const config = loadConfig(workspaceRoot, detDeps.env);
  const detection = detectEnvironment(config, undefined, detDeps);

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
