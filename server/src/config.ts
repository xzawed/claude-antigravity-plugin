import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
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
  return {
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

  // Mask common Google/Gemini API key patterns (AIza...)
  result = result.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');

  return result;
}
