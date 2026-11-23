import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, maskSecrets } from './config.js';
import { detectEnvironment, DetectorDeps, getDefaultDetectorDeps } from './detector.js';
import { buildCliSpawnSpec, queryAgyCapabilities } from './engines/subscription.js';
import {
  AgAuthMethod,
  AgAuthToolInput,
  AgAuthToolOutput,
  AgyModelInfo,
} from './types.js';

export type AuthSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => ChildProcess;

export interface AuthDependencies {
  detectorDeps?: DetectorDeps;
  queryCapabilitiesFn?: (
    cliPath: string,
    platform?: NodeJS.Platform,
  ) =>
    | Promise<{ models: AgyModelInfo[]; agents: string[]; warnings: string[] }>
    | { models: AgyModelInfo[]; agents: string[]; warnings: string[] };
  spawnFn?: AuthSpawnFn;
  homeDir?: string;
  sessionManager?: PendingAuthSessionManager;
  manualPromptTimeoutMs?: number;
  completeTimeoutMs?: number;
}

interface PendingAuthSession {
  sessionId: string;
  workspaceRoot: string;
  cliPath: string;
  platform: NodeJS.Platform;
  child: ChildProcess;
  authUrl?: string;
  stdout: string;
  stderr: string;
  createdAt: number;
  ttlTimer: NodeJS.Timeout;
  closed: boolean;
  exitCode: number | null;
}

const DEFAULT_PENDING_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MANUAL_PROMPT_TIMEOUT_MS = 15_000;
const DEFAULT_COMPLETE_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_TIMEOUT_SEC = 180;

export class PendingAuthSessionManager {
  private readonly sessions = new Map<string, PendingAuthSession>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_PENDING_SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  public register(
    workspaceRoot: string,
    cliPath: string,
    platform: NodeJS.Platform,
    child: ChildProcess,
    authUrl?: string,
    initialStdout = '',
    initialStderr = '',
  ): PendingAuthSession {
    const sessionId = `ag-auth-${crypto.randomBytes(4).toString('hex')}`;
    const ttlTimer = setTimeout(() => {
      this.cancel(sessionId);
    }, this.ttlMs);
    ttlTimer.unref?.();

    const session: PendingAuthSession = {
      sessionId,
      workspaceRoot,
      cliPath,
      platform,
      child,
      authUrl,
      stdout: initialStdout,
      stderr: initialStderr,
      createdAt: Date.now(),
      ttlTimer,
      closed: false,
      exitCode: null,
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      session.stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      session.stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.once('close', (code) => {
      session.closed = true;
      session.exitCode = code;
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  public get(sessionId?: string): PendingAuthSession | undefined {
    if (sessionId) {
      return this.sessions.get(sessionId);
    }
    // Return most recently created active session when sessionId is omitted
    let latest: PendingAuthSession | undefined;
    for (const s of this.sessions.values()) {
      if (!latest || s.createdAt > latest.createdAt) {
        latest = s;
      }
    }
    return latest;
  }

  public remove(sessionId: string): PendingAuthSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      clearTimeout(existing.ttlTimer);
      this.sessions.delete(sessionId);
    }
    return existing;
  }

  public cancel(sessionId?: string): boolean {
    const target = this.get(sessionId);
    if (!target) {
      return false;
    }
    this.remove(target.sessionId);
    if (!target.closed) {
      try {
        target.child.kill();
      } catch {
        // ignore
      }
    }
    return true;
  }

  public disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.cancel(id);
    }
  }

  public size(): number {
    return this.sessions.size;
  }
}

export const defaultAuthSessionManager = new PendingAuthSessionManager();

export function disposePendingAuthSessions(): void {
  defaultAuthSessionManager.disposeAll();
}

/**
 * Extracts Google OAuth (or generic OAuth) URL printed by `agy acp --login`.
 */
export function extractOAuthUrl(text: string): string | undefined {
  const googleMatch = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/i);
  if (googleMatch) {
    return googleMatch[0].replace(/[.,;)]+$/, '');
  }
  const genericMatch = text.match(/https:\/\/[^\s"'<>]*(?:oauth|auth|login)[^\s"'<>]*/i);
  if (genericMatch) {
    return genericMatch[0].replace(/[.,;)]+$/, '');
  }
  return undefined;
}

/**
 * Reads non-secret auth hints from `~/.gemini/antigravity-cli/settings.json`.
 */
export function readAgySettingsAuthHints(homeDir: string = os.homedir()): {
  modelProvider?: string;
  hasGcpConfig: boolean;
} {
  const settingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) {
      return { hasGcpConfig: false };
    }
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const modelProvider =
      typeof raw.modelProvider === 'string' && raw.modelProvider.trim().length > 0
        ? raw.modelProvider.trim()
        : undefined;
    const hasGcpConfig = Boolean(raw.gcp && typeof raw.gcp === 'object');
    return { modelProvider, hasGcpConfig };
  } catch {
    return { hasGcpConfig: false };
  }
}

/**
 * Detects SSH / headless environments where launching a local browser will fail.
 */
export function isHeadlessOrSshEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) {
    return true;
  }
  if (env.CI === 'true' || env.CI === '1') {
    return true;
  }
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  },
): ChildProcess {
  return spawn(command, args, options);
}

function getInstallNextSteps(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      'Install Antigravity CLI (`agy`) or Antigravity Desktop App from https://antigravity.google/docs/getting-started',
      'After installing `agy`, run `/ag-login` again in Claude Code to sign in with your Google account.',
      'Or use Gemini API fallback mode without installing `agy`: `$env:GEMINI_API_KEY="your-key"` then `/ag-config mode api`.',
    ];
  }
  return [
    'Install Antigravity CLI (`agy`) or Antigravity Desktop App from https://antigravity.google/docs/getting-started',
    'After installing `agy`, run `/ag-login` again in Claude Code to sign in with your Google account.',
    'Or use Gemini API fallback mode without installing `agy`: `export GEMINI_API_KEY="your-key"` then `/ag-config mode api`.',
  ];
}

export async function checkAgAuthStatus(
  workspaceRootInput?: string,
  deps: AuthDependencies = {},
): Promise<AgAuthToolOutput> {
  const workspaceRoot = path.resolve(workspaceRootInput ?? process.cwd());
  const detDeps = deps.detectorDeps ?? getDefaultDetectorDeps();
  const env = detDeps.env ?? process.env;
  const config = loadConfig(workspaceRoot, env);
  const detection = detectEnvironment(config, undefined, detDeps);
  const hints = readAgySettingsAuthHints(deps.homeDir);

  const cliDetected = detection.subscription.detected;
  const cliBinary = detection.subscription.cliBinary;
  const cliPath = detection.subscription.cliPath;
  const warnings: string[] = [];

  if (!cliDetected || !cliPath) {
    if (detection.api.configured) {
      return {
        ok: true,
        action: 'status',
        status: 'AUTHENTICATED',
        authenticated: true,
        authMethod: 'gemini-api-key',
        cliDetected: false,
        message:
          'Antigravity CLI (`agy`) is not installed, but Gemini API fallback (`GEMINI_API_KEY`) is configured and ready.',
        nextSteps: [
          'You can delegate tasks immediately using API mode (`/ag-delegate ...`).',
          'For Subscription mode (no per-token billing + real browser E2E), install `agy` and run `/ag-login`.',
        ],
        warnings,
      };
    }

    return {
      ok: false,
      action: 'status',
      status: 'CLI_NOT_INSTALLED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: false,
      message: 'Antigravity CLI (`agy`) was not detected on this machine and no `GEMINI_API_KEY` is configured.',
      nextSteps: getInstallNextSteps(detection.platform),
      warnings,
      errorCode: 'AGY_CLI_NOT_FOUND',
      errorMessage: 'Antigravity CLI (`agy`) is not installed or not found in PATH/standard install directories.',
    };
  }

  // Detect auth method hint from env/settings
  let authMethod: AgAuthMethod = 'google-oauth';
  if (env.AGY_ADC_AUTH === 'true' || env.AGY_ADC_AUTH === '1') {
    authMethod = 'adc';
  } else if (hints.modelProvider === 'gemini') {
    authMethod = 'gemini-api-key';
  }

  if (cliBinary !== 'agy') {
    return {
      ok: true,
      action: 'status',
      status: 'UNAUTHENTICATED',
      authenticated: false,
      authMethod: 'unknown',
      cliDetected: true,
      cliBinary,
      cliPath,
      message: `Legacy Antigravity binary (\`${cliBinary}\`) detected at ${cliPath}. Interactive \`/ag-login\` requires the modern \`agy\` CLI.`,
      nextSteps: [
        'Upgrade to the latest Antigravity CLI (`agy`) or sign in via the Antigravity Desktop App.',
      ],
      warnings: ['Live OAuth status verification is only supported for the `agy` CLI binary.'],
    };
  }

  // Live verification via `agy models`
  const queryFn = deps.queryCapabilitiesFn ?? queryAgyCapabilities;
  const cap = await queryFn(cliPath, detection.platform);
  warnings.push(...cap.warnings);

  if (cap.models.length > 0) {
    return {
      ok: true,
      action: 'status',
      status: 'AUTHENTICATED',
      authenticated: true,
      authMethod,
      cliDetected: true,
      cliBinary,
      cliPath,
      modelCount: cap.models.length,
      message: `Authenticated with Antigravity (${authMethod}). ${cap.models.length} models are available via \`agy\`.`,
      nextSteps: [
        'Run `/ag-delegate <task>` to delegate work to Antigravity.',
        'Run `/ag-login --force` if you want to re-authenticate or switch accounts.',
      ],
      warnings,
    };
  }

  return {
    ok: true,
    action: 'status',
    status: 'UNAUTHENTICATED',
    authenticated: false,
    authMethod: 'none',
    cliDetected: true,
    cliBinary,
    cliPath,
    modelCount: 0,
    message:
      'Antigravity CLI (`agy`) is installed, but no active authenticated session was verified (`agy models` returned 0 models).',
    nextSteps: [
      'Run `/ag-login` to open Google OAuth login in your browser.',
      'Over SSH or headless terminals, run `/ag-login --manual` to get a clickable OAuth link and paste the code back.',
    ],
    warnings,
  };
}

async function startManualLoginFlow(
  workspaceRoot: string,
  cliPath: string,
  cliBinary: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: AuthDependencies,
): Promise<AgAuthToolOutput> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const manager = deps.sessionManager ?? defaultAuthSessionManager;
  const promptTimeoutMs = deps.manualPromptTimeoutMs ?? DEFAULT_MANUAL_PROMPT_TIMEOUT_MS;

  const spec = buildCliSpawnSpec(cliPath, ['acp', '--login'], platform);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    // Force `agy acp --login` into headless URL + authorization-code paste mode
    SSH_CONNECTION: env.SSH_CONNECTION || '127.0.0.1 50000 127.0.0.1 22',
  };

  let child: ChildProcess;
  try {
    child = spawnFn(spec.command, spec.args, {
      cwd: workspaceRoot,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: spec.windowsHide,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (err) {
    const msg = maskSecrets(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      action: 'login',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      cliBinary,
      cliPath,
      message: `Failed to spawn \`agy acp --login\`: ${msg}`,
      nextSteps: ['Verify `agy` is executable and try running `agy acp --login` in your terminal.'],
      warnings: [],
      errorCode: 'AUTH_LOGIN_FAILED',
      errorMessage: msg,
    };
  }

  return new Promise<AgAuthToolOutput>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (out: AgAuthToolOutput): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
        resolve(out);
      }
    };

    const checkForUrl = (): void => {
      const combined = `${stdout}\n${stderr}`;
      const authUrl = extractOAuthUrl(combined);
      if (authUrl) {
        const session = manager.register(
          workspaceRoot,
          cliPath,
          platform,
          child,
          authUrl,
          stdout,
          stderr,
        );
        finish({
          ok: true,
          action: 'login',
          status: 'AWAITING_CODE',
          authenticated: false,
          authMethod: 'google-oauth',
          cliDetected: true,
          cliBinary,
          cliPath,
          sessionId: session.sessionId,
          authUrl,
          message:
            'Google OAuth login link generated. Open the URL in your browser, sign in, copy the authorization code (or full redirect URL), and finish with `/ag-login complete <code>`.',
          nextSteps: [
            `1. Open this link in your browser: ${authUrl}`,
            '2. Sign in with your Google account and grant permissions.',
            `3. Copy the displayed authorization code (or final URL) and run: /ag-login complete <code-or-url>`,
            `   (Pending session: ${session.sessionId} — expires in 5 minutes; cancel with /ag-login cancel)`,
          ],
          warnings: [],
        });
      }
    };

    const onStdout = (chunk: Buffer | string): void => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      checkForUrl();
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      checkForUrl();
    };
    const onError = (err: Error): void => {
      const msg = maskSecrets(err.message);
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        message: `\`agy acp --login\` process error: ${msg}`,
        nextSteps: ['Try running `agy acp --login` directly in your terminal.'],
        warnings: [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: msg,
      });
    };
    const onClose = async (code: number | null): Promise<void> => {
      if (code === 0) {
        const verified = await checkAgAuthStatus(workspaceRoot, deps);
        finish({
          ...verified,
          action: 'login',
          message: verified.authenticated
            ? `Antigravity login succeeded (${verified.modelCount ?? 0} models available).`
            : 'Antigravity login process exited cleanly, but no active models were returned yet.',
        });
        return;
      }
      const detail = maskSecrets((stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' '));
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        message: `\`agy acp --login\` exited with code ${code ?? 'unknown'} before printing an OAuth URL.`,
        nextSteps: ['Run `agy acp --login` in your terminal to inspect full output.'],
        warnings: detail ? [detail] : [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: detail || `agy acp --login exited with code ${code ?? 'unknown'}`,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        message: 'Timed out waiting for `agy acp --login` to output a Google OAuth URL.',
        nextSteps: ['Try `/ag-login` (browser flow) or run `agy acp --login` directly in your terminal.'],
        warnings: [],
        errorCode: 'AUTH_TIMEOUT',
        errorMessage: `Timed out after ${promptTimeoutMs}ms waiting for OAuth URL.`,
      });
    }, promptTimeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', (code) => {
      void onClose(code);
    });
  });
}

async function runBrowserLoginFlow(
  workspaceRoot: string,
  cliPath: string,
  cliBinary: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  timeoutSec: number,
  deps: AuthDependencies,
): Promise<AgAuthToolOutput> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const manager = deps.sessionManager ?? defaultAuthSessionManager;

  const spec = buildCliSpawnSpec(cliPath, ['acp', '--login'], platform);
  // Strip SSH env markers when user explicitly requests local browser login
  const cleanEnv: NodeJS.ProcessEnv = { ...env };
  delete cleanEnv.SSH_CONNECTION;
  delete cleanEnv.SSH_TTY;
  delete cleanEnv.SSH_CLIENT;

  let child: ChildProcess;
  try {
    child = spawnFn(spec.command, spec.args, {
      cwd: workspaceRoot,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: spec.windowsHide,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (err) {
    const msg = maskSecrets(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      action: 'login',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      cliBinary,
      cliPath,
      message: `Failed to launch \`agy acp --login\`: ${msg}`,
      nextSteps: ['Try `/ag-login --manual` or run `agy acp --login` directly in your terminal.'],
      warnings: [],
      errorCode: 'AUTH_LOGIN_FAILED',
      errorMessage: msg,
    };
  }

  return new Promise<AgAuthToolOutput>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (out: AgAuthToolOutput): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
        resolve(out);
      }
    };

    const checkUnexpectedManualPrompt = (): void => {
      const combined = `${stdout}\n${stderr}`;
      // If agy fell back to manual code-paste prompt (e.g. browser unavailable), don't hang — switch seamlessly to AWAITING_CODE
      if (/paste the authorization code/i.test(combined)) {
        const authUrl = extractOAuthUrl(combined);
        const session = manager.register(
          workspaceRoot,
          cliPath,
          platform,
          child,
          authUrl,
          stdout,
          stderr,
        );
        finish({
          ok: true,
          action: 'login',
          status: 'AWAITING_CODE',
          authenticated: false,
          authMethod: 'google-oauth',
          cliDetected: true,
          cliBinary,
          cliPath,
          sessionId: session.sessionId,
          authUrl,
          message:
            '`agy acp --login` switched to manual authorization-code mode. Open the OAuth URL in your browser and complete with `/ag-login complete <code>`.',
          nextSteps: [
            ...(authUrl ? [`1. Open this link in your browser: ${authUrl}`] : []),
            '2. Complete Google sign-in and copy the authorization code (or callback URL).',
            '3. Run `/ag-login complete <code-or-url>` in Claude Code.',
          ],
          warnings: [],
        });
      }
    };

    const onStdout = (chunk: Buffer | string): void => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      checkUnexpectedManualPrompt();
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      checkUnexpectedManualPrompt();
    };
    const onError = (err: Error): void => {
      const msg = maskSecrets(err.message);
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        message: `\`agy acp --login\` failed to start: ${msg}`,
        nextSteps: ['Try `/ag-login --manual` or run `agy acp --login` in your terminal.'],
        warnings: [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: msg,
      });
    };
    const onClose = async (code: number | null): Promise<void> => {
      if (code === 0) {
        const verified = await checkAgAuthStatus(workspaceRoot, deps);
        finish({
          ...verified,
          action: 'login',
          message: verified.authenticated
            ? `Antigravity Google OAuth login completed and saved to your OS keyring (${verified.modelCount ?? 0} models ready).`
            : 'Browser login exited with status 0, but `agy models` did not confirm active models yet. Re-run `/ag-login status` in a moment.',
        });
        return;
      }

      const detail = maskSecrets((stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' '));
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        message: `Antigravity browser login failed (exit code ${code ?? 'unknown'}).`,
        nextSteps: [
          'Try `/ag-login --manual` to sign in using a clickable OAuth link + authorization code.',
        ],
        warnings: detail ? [detail] : [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: detail || `agy acp --login exited with code ${code ?? 'unknown'}`,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      const authUrl = extractOAuthUrl(`${stdout}\n${stderr}`);
      finish({
        ok: false,
        action: 'login',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary,
        cliPath,
        authUrl,
        message: `Browser login timed out after ${timeoutSec}s before Google OAuth completed.`,
        nextSteps: [
          'Run `/ag-login --manual` to get a Google OAuth link and paste the authorization code directly in Claude Code.',
        ],
        warnings: [],
        errorCode: 'AUTH_TIMEOUT',
        errorMessage: `Browser login timed out after ${timeoutSec}s.`,
      });
    }, timeoutSec * 1000);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', (code) => {
      void onClose(code);
    });
  });
}

async function completeManualLoginFlow(
  code: string | undefined,
  sessionId: string | undefined,
  deps: AuthDependencies,
): Promise<AgAuthToolOutput> {
  const manager = deps.sessionManager ?? defaultAuthSessionManager;
  const completeTimeoutMs = deps.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;

  const trimmedCode = code?.trim() ?? '';
  if (!trimmedCode) {
    return {
      ok: false,
      action: 'complete',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      message: 'Missing authorization code or callback URL. Provide it via `/ag-login complete <code-or-url>`.',
      nextSteps: ['Run `/ag-login complete <code-or-url>` with the code from your browser.'],
      warnings: [],
      errorCode: 'AUTH_LOGIN_FAILED',
      errorMessage: 'Authorization code is required for action="complete".',
    };
  }

  const session = manager.get(sessionId);
  if (!session) {
    return {
      ok: false,
      action: 'complete',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      message: sessionId
        ? `No active login session found for "${sessionId}" (it may have expired or already completed).`
        : 'No active pending login session found. Start one first with `/ag-login --manual`.',
      nextSteps: ['Run `/ag-login --manual` to start a new OAuth login session.'],
      warnings: [],
      errorCode: 'AUTH_SESSION_NOT_FOUND',
      errorMessage: 'Pending auth session not found or expired.',
    };
  }

  manager.remove(session.sessionId);

  if (session.closed) {
    return {
      ok: false,
      action: 'complete',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      cliBinary: 'agy',
      cliPath: session.cliPath,
      message: 'The pending `agy acp --login` process already exited before the code was submitted.',
      nextSteps: ['Run `/ag-login --manual` to generate a fresh OAuth link.'],
      warnings: [],
      errorCode: 'AUTH_SESSION_NOT_FOUND',
      errorMessage: 'Login process already exited.',
    };
  }

  return new Promise<AgAuthToolOutput>((resolve) => {
    let settled = false;
    const finish = (out: AgAuthToolOutput): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(out);
      }
    };

    const timer = setTimeout(() => {
      try {
        session.child.kill();
      } catch {
        // ignore
      }
      finish({
        ok: false,
        action: 'complete',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary: 'agy',
        cliPath: session.cliPath,
        message: 'Timed out waiting for `agy acp --login` to exchange the authorization code.',
        nextSteps: [
          'Check that you copied the full authorization code or callback URL, then retry `/ag-login --manual`.',
        ],
        warnings: [],
        errorCode: 'AUTH_TIMEOUT',
        errorMessage: `Timed out after ${completeTimeoutMs}ms exchanging authorization code.`,
      });
    }, completeTimeoutMs);

    session.child.once('close', async (exitCode) => {
      if (exitCode === 0) {
        const verified = await checkAgAuthStatus(session.workspaceRoot, deps);
        finish({
          ...verified,
          action: 'complete',
          message: verified.authenticated
            ? `Antigravity login succeeded and credentials were saved to your OS keyring (${verified.modelCount ?? 0} models available).`
            : 'Authorization code accepted (`agy acp --login` exited 0), but model verification did not confirm active models yet.',
        });
        return;
      }

      // Never echo the raw authorization code back in logs or error messages
      const detail = maskSecrets(
        (session.stderr || session.stdout).trim().split(/\r?\n/).slice(-3).join(' '),
      );
      finish({
        ok: false,
        action: 'complete',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary: 'agy',
        cliPath: session.cliPath,
        message: `Authorization code exchange failed (exit code ${exitCode ?? 'unknown'}).`,
        nextSteps: [
          'Start a fresh login with `/ag-login --manual` and paste the new authorization code or full callback URL.',
        ],
        warnings: detail ? [detail] : [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: detail || `Code exchange failed with exit code ${exitCode ?? 'unknown'}.`,
      });
    });

    try {
      session.child.stdin?.write(`${trimmedCode}\n`);
      session.child.stdin?.end();
    } catch (err) {
      const msg = maskSecrets(err instanceof Error ? err.message : String(err));
      finish({
        ok: false,
        action: 'complete',
        status: 'FAILED',
        authenticated: false,
        authMethod: 'none',
        cliDetected: true,
        cliBinary: 'agy',
        cliPath: session.cliPath,
        message: `Failed to deliver authorization code to \`agy acp --login\`: ${msg}`,
        nextSteps: ['Retry `/ag-login --manual`.'],
        warnings: [],
        errorCode: 'AUTH_LOGIN_FAILED',
        errorMessage: msg,
      });
    }
  });
}

export async function handleAgAuth(
  input: AgAuthToolInput = {},
  deps: AuthDependencies = {},
): Promise<AgAuthToolOutput> {
  const action = input.action ?? 'login';
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const detDeps = deps.detectorDeps ?? getDefaultDetectorDeps();
  const env = detDeps.env ?? process.env;
  const manager = deps.sessionManager ?? defaultAuthSessionManager;

  if (action === 'status') {
    return checkAgAuthStatus(workspaceRoot, deps);
  }

  if (action === 'cancel') {
    const cancelled = manager.cancel(input.sessionId);
    return {
      ok: true,
      action: 'cancel',
      status: 'CANCELLED',
      authenticated: false,
      authMethod: 'none',
      cliDetected: true,
      message: cancelled
        ? 'Cancelled the pending Antigravity OAuth login session.'
        : 'No pending Antigravity login session was active.',
      nextSteps: ['Run `/ag-login` whenever you are ready to sign in.'],
      warnings: [],
    };
  }

  if (action === 'complete') {
    return completeManualLoginFlow(input.code, input.sessionId, deps);
  }

  if (action === 'logout') {
    const config = loadConfig(workspaceRoot, env);
    const detection = detectEnvironment(config, undefined, detDeps);
    const hints = readAgySettingsAuthHints(deps.homeDir);
    const nextSteps: string[] = [];

    if (detection.subscription.detected) {
      nextSteps.push(
        'To purge saved Google OAuth credentials from your OS keyring, open a terminal, run `agy`, and type `/logout`.',
      );
    }
    if (env.AGY_ADC_AUTH) {
      nextSteps.push('To disconnect Application Default Credentials (ADC), unset `AGY_ADC_AUTH` in your shell.');
    }
    if (hints.modelProvider === 'gemini' || detection.api.configured) {
      nextSteps.push(
        'If using a Gemini API key, unset `GEMINI_API_KEY` (and remove `"modelProvider": "gemini"` from `~/.gemini/antigravity-cli/settings.json` if set).',
      );
    }
    if (nextSteps.length === 0) {
      nextSteps.push('No active Antigravity CLI installation or API key was detected.');
    }

    return {
      ok: true,
      action: 'logout',
      status: 'LOGOUT_INSTRUCTIONS',
      authenticated: false,
      authMethod: 'none',
      cliDetected: detection.subscription.detected,
      cliBinary: detection.subscription.cliBinary,
      cliPath: detection.subscription.cliPath,
      message:
        'Antigravity stores OAuth tokens in your OS native secure keyring and requires interactive confirmation via `/logout` inside `agy` to purge them safely.',
      nextSteps,
      warnings: [],
    };
  }

  // action === 'login'
  const config = loadConfig(workspaceRoot, env);
  const detection = detectEnvironment(config, undefined, detDeps);

  if (!detection.subscription.detected || !detection.subscription.cliPath) {
    return {
      ok: false,
      action: 'login',
      status: 'CLI_NOT_INSTALLED',
      authenticated: false,
      authMethod: detection.api.configured ? 'gemini-api-key' : 'none',
      cliDetected: false,
      message:
        'Cannot run Google OAuth login because Antigravity CLI (`agy`) is not installed or not found on this machine.',
      nextSteps: getInstallNextSteps(detection.platform),
      warnings: [],
      errorCode: 'AGY_CLI_NOT_FOUND',
      errorMessage: 'Antigravity CLI (`agy`) is required for `/ag-login` OAuth sign-in.',
    };
  }

  if (detection.subscription.cliBinary !== 'agy') {
    return {
      ok: false,
      action: 'login',
      status: 'FAILED',
      authenticated: false,
      authMethod: 'unknown',
      cliDetected: true,
      cliBinary: detection.subscription.cliBinary,
      cliPath: detection.subscription.cliPath,
      message: `Detected legacy binary \`${detection.subscription.cliBinary}\`, which does not support \`acp --login\`.`,
      nextSteps: [
        'Install the official `agy` CLI from https://antigravity.google/docs/getting-started, or sign in via the Antigravity Desktop App.',
      ],
      warnings: [],
      errorCode: 'AUTH_LOGIN_FAILED',
      errorMessage: 'OAuth login via `acp --login` requires the `agy` CLI binary.',
    };
  }

  if (!input.force) {
    const current = await checkAgAuthStatus(workspaceRoot, deps);
    if (current.authenticated && current.cliDetected) {
      return {
        ...current,
        action: 'login',
        message: `Already signed in to Antigravity (${current.authMethod}, ${current.modelCount ?? 0} models available). Use \`/ag-login --force\` to re-authenticate or switch accounts.`,
        nextSteps: [
          'Ready to delegate! Run `/ag-delegate <task>` or `/ag-models`.',
          'To switch Google accounts or refresh credentials, run `/ag-login --force` (or `/ag-login --manual --force`).',
        ],
      };
    }
  }

  const requestedFlow = input.flow ?? 'auto';
  const effectiveFlow =
    requestedFlow === 'auto'
      ? isHeadlessOrSshEnv(env, detection.platform)
        ? 'manual'
        : 'browser'
      : requestedFlow;

  if (effectiveFlow === 'manual') {
    return startManualLoginFlow(
      workspaceRoot,
      detection.subscription.cliPath,
      detection.subscription.cliBinary,
      detection.platform,
      env,
      deps,
    );
  }

  const timeoutSec = Math.min(600, Math.max(15, input.timeoutSec ?? DEFAULT_BROWSER_TIMEOUT_SEC));
  return runBrowserLoginFlow(
    workspaceRoot,
    detection.subscription.cliPath,
    detection.subscription.cliBinary,
    detection.platform,
    env,
    timeoutSec,
    deps,
  );
}
