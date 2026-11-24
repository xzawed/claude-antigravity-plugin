import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveGitExcludePath } from './bridge-fs.js';
import { isFullyQualifiedPath } from './exec-path.js';
import { checkTrackedFile } from './git-guard.js';
import { isInsideWorkspace } from './path-guard.js';
import {
  AgPluginError,
  BridgeConfig,
  DEFAULT_BRIDGE_CONFIG,
  ExecutionMode,
} from './types.js';

const ExecutionModeSchema = z.enum(['auto', 'subscription', 'api']);
const GitGuardPolicySchema = z.enum(['best_effort', 'required']);
const TriggerMethodSchema = z.enum(['cli_or_ipc', 'cli_only', 'clipboard']);
const AgyModeSchema = z.enum(['accept-edits', 'auto', 'plan']);
const AgyEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const PartialBridgeConfigSchema = z
  .object({
    execution_mode: ExecutionModeSchema.optional(),
    git_guard: GitGuardPolicySchema.optional(),
    subscription: z
      .object({
        app_path: z.string().min(1).optional(),
        trigger_method: TriggerMethodSchema.optional(),
        timeout_sec: z.number().int().min(1).max(3600).optional(),
        poll_interval_ms: z.number().int().min(100).max(30000).optional(),
        agy_mode: AgyModeSchema.optional(),
        agy_sandbox: z.boolean().optional(),
        agy_dangerously_skip_permissions: z.boolean().optional(),
        agy_stream_heartbeat: z.boolean().optional(),
        agy_model: z.string().min(1).optional(),
        agy_effort: AgyEffortSchema.optional(),
        agy_agent: z.string().min(1).optional(),
        agy_project: z.string().min(1).optional(),
        agy_remote_agent: z.boolean().optional(),
        agy_disable_slash_commands: z.boolean().optional(),
        agy_settings: z.string().min(1).optional(),
      })
      .partial()
      .optional(),
    api: z
      .object({
        api_key_env: z.string().min(1).optional(),
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        max_turns: z.number().int().min(1).max(50).optional(),
        command_timeout_sec: z.number().int().min(5).max(600).optional(),
      })
      .partial()
      .optional(),
  })
  .strict();

export function getConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ag-bridge', 'config.json');
}

export function loadConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const envModeRaw = env.AG_DEFAULT_MODE?.trim();
  const envMode: ExecutionMode =
    envModeRaw === 'auto' || envModeRaw === 'subscription' || envModeRaw === 'api'
      ? envModeRaw
      : DEFAULT_BRIDGE_CONFIG.execution_mode;

  const envModel = env.AG_MODEL?.trim() || DEFAULT_BRIDGE_CONFIG.api.model;
  const envSkipPerm =
    env.AG_DANGEROUSLY_SKIP_PERMISSIONS === '1' ||
    env.AG_DANGEROUSLY_SKIP_PERMISSIONS?.toLowerCase() === 'true';

  const base: BridgeConfig = {
    execution_mode: envMode,
    git_guard: DEFAULT_BRIDGE_CONFIG.git_guard,
    subscription: {
      ...DEFAULT_BRIDGE_CONFIG.subscription,
      agy_dangerously_skip_permissions: envSkipPerm,
    },
    api: {
      ...DEFAULT_BRIDGE_CONFIG.api,
      model: envModel,
    },
  };

  const configPath = getConfigPath(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    return base;
  }

  let parsedRaw: unknown;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    parsedRaw = JSON.parse(content);
  } catch (err) {
    throw new AgPluginError(
      'INVALID_CONFIG',
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = PartialBridgeConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new AgPluginError(
      'INVALID_CONFIG',
      `Invalid .ag-bridge/config.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  const data = parsed.data;
  const merged: BridgeConfig = {
    execution_mode: data.execution_mode ?? base.execution_mode,
    git_guard: data.git_guard ?? base.git_guard,
    subscription: {
      ...base.subscription,
      ...(data.subscription ?? {}),
    },
    api: {
      ...base.api,
      ...(data.api ?? {}),
    },
  };
  const ignored = applyConfigTrust(workspaceRoot, data, merged, base);
  return ignored.length > 0 ? { ...merged, ignoredSettings: ignored } : merged;
}

type TrustSection = 'subscription' | 'api';

/**
 * Settings a repository must not decide: each picks a program or a secret, or weakens a safety
 * default. `.ag-bridge/config.json` lives in the workspace and a repository can commit one, so
 * these are honored only from a config git does not track — the plugin keeps `.ag-bridge/` out of
 * git, so the user's own file (written by `/ag-config`) is untracked. ARC-003 §7, TC-S17 ~ TC-S19.
 */
const TRUST_SENSITIVE: Array<[TrustSection, string, (value: unknown) => boolean]> = [
  ['subscription', 'app_path', (v) => v !== undefined && v !== 'auto'],
  ['subscription', 'agy_dangerously_skip_permissions', (v) => v === true],
  ['subscription', 'agy_sandbox', (v) => v === false],
  ['subscription', 'agy_mode', (v) => v === 'auto'],
  ['subscription', 'agy_settings', (v) => v !== undefined],
  ['subscription', 'agy_remote_agent', (v) => v === true],
  // agy runs agents the workspace defines in .agents/agents/ — their prompt, tool policy and hooks
  ['subscription', 'agy_agent', (v) => v !== undefined],
  // --project brings that project's folders into the session: their agents load, their hooks run
  ['subscription', 'agy_project', (v) => v !== undefined],
  ['api', 'apiKey', (v) => v !== undefined],
  ['api', 'api_key_env', (v) => v !== undefined && v !== DEFAULT_BRIDGE_CONFIG.api.api_key_env],
];

/**
 * Why `.ag-bridge/config.json` may not be the user's own, or undefined when it is: the user's file
 * is a regular file under a real `.ag-bridge/` directory of which git tracks nothing. The pathspec
 * names the directory so it also matches a submodule's gitlink (git does not list files inside a
 * submodule, TC-S18f), and it is case-insensitive because Windows and macOS read
 * `.AG-BRIDGE/CONFIG.JSON` as this file (TC-S18d). A link could lead to a file git tracks under
 * another name (TC-S18e).
 */
function whyConfigIsNotUsers(workspaceRoot: string): string | undefined {
  const dir = path.join(workspaceRoot, '.ag-bridge');
  for (const p of [dir, path.join(dir, 'config.json')]) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        return 'the file is reached through a link';
      }
    } catch {
      // missing: nothing to read through
    }
  }
  const trackedState = checkTrackedFile(workspaceRoot, ':(icase).ag-bridge');
  if (trackedState === 'tracked') {
    return 'the file is tracked by git, so the repository may have supplied it';
  }
  if (trackedState === 'unknown' && resolveGitExcludePath(workspaceRoot) !== null) {
    // Fail-closed: a git work tree is present, but git could not confirm the config is untracked
    // (e.g. dubious ownership, timeout, or git unavailable on PATH).
    return 'git could not verify whether the file is tracked in this repository';
  }
  return undefined;
}

function applyConfigTrust(
  workspaceRoot: string,
  data: z.infer<typeof PartialBridgeConfigSchema>,
  merged: BridgeConfig,
  base: BridgeConfig,
): string[] {
  const ignored: string[] = [];
  const fromFile = (section: TrustSection, key: string): unknown =>
    (data[section] as Record<string, unknown> | undefined)?.[key];
  const unsafe = TRUST_SENSITIVE.filter(([section, key, isUnsafe]) => isUnsafe(fromFile(section, key)));

  // git runs only when the file sets one of these, so an ordinary config costs no process.
  const notOwn = unsafe.length > 0 ? whyConfigIsNotUsers(workspaceRoot) : undefined;
  if (notOwn) {
    for (const [section, key] of unsafe) {
      const target = merged[section] as unknown as Record<string, unknown>;
      const fallback = (base[section] as unknown as Record<string, unknown>)[key];
      if (fallback === undefined) delete target[key];
      else target[key] = fallback;
      ignored.push(`${section}.${key} (${notOwn})`);
    }
  }

  // From any config: the program to launch must be absolute and outside the workspace.
  const appPath = merged.subscription.app_path;
  if (appPath !== 'auto' && (!isFullyQualifiedPath(appPath) || isInsideWorkspace(workspaceRoot, appPath))) {
    merged.subscription.app_path = 'auto';
    ignored.push('subscription.app_path (not an absolute path outside the workspace)');
  }
  return ignored;
}

/** One recommendation naming every setting `loadConfig` ignored, and how to keep them. */
export function describeIgnoredSettings(config: BridgeConfig): string | undefined {
  if (!config.ignoredSettings || config.ignoredSettings.length === 0) {
    return undefined;
  }
  return (
    `Ignored settings from .ag-bridge/config.json: ${config.ignoredSettings.join('; ')}. ` +
    'To use them, keep the file out of git (`git rm --cached .ag-bridge/config.json`) and point ' +
    'subscription.app_path at an agy installed outside the project, or pass the option per call.'
  );
}

export function resolveApiKey(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): { key?: string; source: 'env' | 'config' | 'none' } {
  const envKey = env[config.api.api_key_env]?.trim();
  if (envKey) {
    return { key: envKey, source: 'env' };
  }
  const configKey = config.api.apiKey?.trim();
  if (configKey) {
    return { key: configKey, source: 'config' };
  }
  return { key: undefined, source: 'none' };
}

export function maskSecrets(
  input: string,
  extraSecrets: Array<string | undefined> = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  let result = input;

  const candidates = new Set<string>();
  const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  for (const k of envKeys) {
    const val = env[k]?.trim();
    if (val && val.length >= 8) {
      candidates.add(val);
    }
  }
  for (const s of extraSecrets) {
    const trimmed = s?.trim();
    if (trimmed && trimmed.length >= 8) {
      candidates.add(trimmed);
    }
  }

  for (const secret of candidates) {
    result = result.split(secret).join('[REDACTED]');
  }

  // Mask common provider API key & OAuth token patterns
  result = result.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
  result = result.replace(/ya29\.[0-9A-Za-z._-]{20,}/g, '[REDACTED]');
  result = result.replace(/\b4\/0[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  result = result.replace(/\bsk-(?:proj-|ant-)?[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]');
  result = result.replace(/\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, '[REDACTED]');
  result = result.replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{16,}/gi, '$1[REDACTED]');

  return result;
}
