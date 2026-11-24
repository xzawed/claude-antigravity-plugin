import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveApiKey } from './config.js';
import { absolutePathDirs } from './exec-path.js';
import {
  AgPluginError,
  BridgeConfig,
  EnvironmentDetectionResult,
  ExecutionMode,
  ResolvedExecutionMode,
  SubscriptionDetection,
} from './types.js';

export interface DetectorDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  existsSync: (p: string) => boolean;
  findBinary: (name: string) => string | undefined;
}

export function findBinaryInPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  existsSyncFn: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // Fully qualified entries only: "." or "bin" would find an agy the opened workspace ships (TC-S13).
  const dirs = absolutePathDirs(platform, env);

  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate =
        ext && !name.toLowerCase().endsWith(ext)
          ? pathApi.join(dir, `${name}${ext}`)
          : pathApi.join(dir, name);
      try {
        if (existsSyncFn(candidate)) {
          return candidate;
        }
      } catch {
        // ignore unreadable path entries
      }
    }
  }
  return undefined;
}

export function getDefaultDetectorDeps(): DetectorDeps {
  const platform = process.platform;
  const env = process.env;
  return {
    platform,
    env,
    homedir: os.homedir(),
    existsSync: (p: string) => fs.existsSync(p),
    findBinary: (name: string) => findBinaryInPath(name, platform, env, fs.existsSync),
  };
}

function getDefaultCliCandidates(deps: DetectorDeps): Array<{ binary: string; path: string }> {
  if (deps.platform === 'win32') {
    const localAppData = deps.env.LOCALAPPDATA ?? path.join(deps.homedir, 'AppData', 'Local');
    return [
      { binary: 'agy', path: path.join(localAppData, 'agy', 'bin', 'agy.exe') },
      { binary: 'agy', path: path.join(deps.homedir, '.gemini', 'antigravity-cli', 'bin', 'agy.exe') },
      { binary: 'agy', path: path.join(deps.homedir, '.local', 'bin', 'agy.exe') },
      { binary: 'antigravity', path: path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd') },
    ];
  }
  return [
    { binary: 'agy', path: path.join(deps.homedir, '.gemini', 'antigravity-cli', 'bin', 'agy') },
    { binary: 'agy', path: path.join(deps.homedir, '.local', 'bin', 'agy') },
    { binary: 'agy', path: '/usr/local/bin/agy' },
    { binary: 'antigravity', path: path.join(deps.homedir, '.local', 'bin', 'antigravity') },
    { binary: 'antigravity', path: '/usr/local/bin/antigravity' },
  ];
}

function getDefaultAppCandidates(deps: DetectorDeps): string[] {
  if (deps.platform === 'darwin') {
    return [
      '/Applications/Antigravity.app',
      path.join(deps.homedir, 'Applications', 'Antigravity.app'),
    ];
  }
  if (deps.platform === 'win32') {
    const localAppData = deps.env.LOCALAPPDATA ?? path.join(deps.homedir, 'AppData', 'Local');
    const programFiles = deps.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
    ];
  }
  return [
    '/usr/bin/antigravity',
    path.join(deps.homedir, '.local', 'bin', 'antigravity'),
    '/opt/Antigravity/antigravity',
  ];
}

function inferCliBinaryFromPath(binaryPath: string): string | undefined {
  const base = path.basename(binaryPath).toLowerCase().replace(/\.(exe|cmd|bat|app)$/, '');
  if (base === 'agy' || base.includes('agy')) {
    return 'agy';
  }
  if (base === 'antigravity' || base.includes('antigravity')) {
    return 'antigravity';
  }
  if (base === 'ag') {
    return 'ag';
  }
  return undefined;
}

export function detectSubscriptionApp(
  config: BridgeConfig,
  deps: DetectorDeps = getDefaultDetectorDeps(),
): SubscriptionDetection {
  const triggerMethod = config.subscription.trigger_method;

  // 1. Explicit app_path override (infer cliBinary so agy flags still apply)
  if (config.subscription.app_path && config.subscription.app_path !== 'auto') {
    if (deps.existsSync(config.subscription.app_path)) {
      return {
        detected: true,
        cliBinary: inferCliBinaryFromPath(config.subscription.app_path),
        appPath: config.subscription.app_path,
        cliPath: config.subscription.app_path,
        triggerMethod,
      };
    }
  }

  // 2. CLI binaries via PATH (ADR-003: agy -> antigravity -> ag)
  let cliBinary: string | undefined;
  let cliPath: string | undefined;
  for (const bin of ['agy', 'antigravity', 'ag']) {
    const found = deps.findBinary(bin);
    if (found) {
      cliBinary = bin;
      cliPath = found;
      break;
    }
  }

  // 2b. Fallback to standard known CLI installation paths (handles stripped MCP host PATH)
  if (!cliPath) {
    for (const candidate of getDefaultCliCandidates(deps)) {
      if (deps.existsSync(candidate.path)) {
        cliBinary = candidate.binary;
        cliPath = candidate.path;
        break;
      }
    }
  }

  // 3. OS Desktop App installation paths
  let appPath: string | undefined;
  for (const candidate of getDefaultAppCandidates(deps)) {
    if (deps.existsSync(candidate)) {
      appPath = candidate;
      break;
    }
  }

  return {
    detected: Boolean(cliPath || appPath),
    cliBinary,
    cliPath,
    appPath,
    triggerMethod,
  };
}

export function detectEnvironment(
  config: BridgeConfig,
  modeOverride?: ExecutionMode,
  deps: DetectorDeps = getDefaultDetectorDeps(),
): EnvironmentDetectionResult {
  const configuredMode = modeOverride ?? config.execution_mode;
  const subscription = detectSubscriptionApp(config, deps);
  const apiKeyInfo = resolveApiKey(config, deps.env);

  const api = {
    configured: Boolean(apiKeyInfo.key),
    source: apiKeyInfo.source,
    envVarName: config.api.api_key_env,
    model: config.api.model,
    maxTurns: config.api.max_turns,
  };

  let resolvedMode: ResolvedExecutionMode | 'unavailable';
  const recommendations: string[] = [];

  if (configuredMode === 'subscription') {
    resolvedMode = subscription.detected ? 'subscription' : 'unavailable';
    if (!subscription.detected) {
      recommendations.push(
        'Local Antigravity app/CLI (agy/antigravity) was not detected. Install Antigravity or switch mode with `/ag-config mode api`.',
      );
    }
  } else if (configuredMode === 'api') {
    resolvedMode = api.configured ? 'api' : 'unavailable';
    if (!api.configured) {
      recommendations.push(
        `Set the ${config.api.api_key_env} environment variable to enable Gemini API Fallback Mode.`,
      );
    }
  } else {
    // auto: Subscription priority -> API fallback
    if (subscription.detected) {
      resolvedMode = 'subscription';
    } else if (api.configured) {
      resolvedMode = 'api';
    } else {
      resolvedMode = 'unavailable';
      recommendations.push(
        'Install & sign in to Antigravity (CLI `agy` or desktop app) for Subscription Mode, OR export GEMINI_API_KEY for API Fallback Mode.',
      );
    }
  }

  if (api.source === 'config') {
    recommendations.push(
      `API key is currently stored in .ag-bridge/config.json. Move it to the ${config.api.api_key_env} environment variable for better security.`,
    );
  }

  return {
    configuredMode,
    resolvedMode,
    platform: deps.platform,
    subscription,
    api,
    recommendations,
  };
}

export function assertResolvedMode(detection: EnvironmentDetectionResult): ResolvedExecutionMode {
  if (detection.resolvedMode !== 'unavailable') {
    return detection.resolvedMode;
  }

  if (detection.configuredMode === 'subscription') {
    throw new AgPluginError(
      'SUBSCRIPTION_UNAVAILABLE',
      detection.recommendations[0] ??
        'Subscription mode was requested, but Antigravity app/CLI was not detected.',
    );
  }

  if (detection.configuredMode === 'api') {
    throw new AgPluginError(
      'API_KEY_MISSING',
      detection.recommendations[0] ??
        `API mode was requested, but ${detection.api.envVarName} is not configured.`,
    );
  }

  throw new AgPluginError(
    'NO_ANTIGRAVITY_PROVIDER',
    detection.recommendations[0] ??
      'Neither local Antigravity (subscription) nor GEMINI_API_KEY (api) is available.',
  );
}
