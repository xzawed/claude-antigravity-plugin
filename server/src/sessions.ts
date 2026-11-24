import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { generateTaskId } from './bridge-fs.js';
import { loadConfig, maskSecrets } from './config.js';
import { detectEnvironment, DetectorDeps, getDefaultDetectorDeps } from './detector.js';
import { requireExecutable } from './exec-path.js';
import { buildCliSpawnSpec } from './engines/subscription.js';
import { createCheckpoint } from './git-guard.js';
import {
  AgSessionSummary,
  AgSessionToolInput,
  AgSessionToolOutput,
  ExecutionMetrics,
  TokenUsage,
} from './types.js';

export type SessionSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => ChildProcess;

export interface SessionDependencies {
  detectorDeps?: DetectorDeps;
  spawnFn?: SessionSpawnFn;
  sessionManager?: PersistentSessionManager;
  idleTtlMs?: number;
}

interface TurnWaiter {
  resolve: (val: TurnResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  textFragments: string[];
}

interface TurnResult {
  status: string;
  response: string;
  structuredOutput?: unknown;
  metrics: ExecutionMetrics;
  errorMessage?: string;
}

interface LivePersistentSession {
  sessionId: string;
  workspaceRoot: string;
  platform: NodeJS.Platform;
  child: ChildProcess;
  active: boolean;
  busy: boolean;
  conversationId?: string;
  model?: string;
  permissionMode?: string;
  numTurns: number;
  durationSeconds: number;
  usage?: TokenUsage;
  gitCheckpointRef?: string;
  createdAt: string;
  lastActivityAt: string;
  stdoutBuffer: string;
  stderrTail: string;
  currentTurn?: TurnWaiter;
  idleTimer: NodeJS.Timeout;
}

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TURN_TIMEOUT_SEC = 300;

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = Number(u.input_tokens ?? u.inputTokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? u.outputTokens ?? 0);
  const thinkingTokens = Number(u.thinking_tokens ?? u.thinkingTokens ?? 0);
  const cacheReadTokens = Number(u.cache_read_tokens ?? u.cacheReadTokens ?? 0);
  const totalTokens = Number(
    u.total_tokens ?? u.totalTokens ?? inputTokens + outputTokens + thinkingTokens,
  );
  if (Number.isNaN(totalTokens)) return undefined;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    thinkingTokens: Number.isFinite(thinkingTokens) ? thinkingTokens : 0,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function killSessionProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  if (!child.pid) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return;
  }
  try {
    if (platform === 'win32') {
      execFileSync(requireExecutable('taskkill'), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

function defaultSessionSpawn(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  },
): ChildProcess {
  return spawn(command, args, options);
}

export function buildStreamSessionArgs(
  input: AgSessionToolInput,
  config: ReturnType<typeof loadConfig>,
): string[] {
  const sub = config.subscription;
  const args: string[] = ['--input-format', 'stream-json', '--output-format', 'stream-json'];

  const skipPermissions =
    input.dangerouslySkipPermissions ?? sub.agy_dangerously_skip_permissions;
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
    if (input.agyMode) {
      args.push('--mode', input.agyMode);
    }
  } else {
    const mode = input.agyMode ?? sub.agy_mode;
    args.push('--mode', mode);
  }

  const useSandbox = input.sandbox ?? sub.agy_sandbox;
  if (useSandbox) {
    args.push('--sandbox');
  }

  const model = input.model ?? sub.agy_model;
  if (model) {
    args.push('--model', model);
  }

  const effort = input.effort ?? sub.agy_effort;
  if (effort) {
    args.push('--effort', effort);
  }

  const agent = input.agent ?? sub.agy_agent;
  if (agent) {
    args.push('--agent', agent);
  }

  if (input.addDirs && input.addDirs.length > 0) {
    for (const d of input.addDirs) {
      args.push('--add-dir', d);
    }
  }

  if (input.conversationId) {
    args.push('--conversation', input.conversationId);
  } else if (input.continueConversation) {
    args.push('--continue');
  }

  const project = input.project ?? sub.agy_project;
  if (project) {
    args.push('--project', project);
  }

  const remoteAgent = input.remoteAgent ?? sub.agy_remote_agent;
  if (remoteAgent) {
    args.push('--remote-agent');
  }

  if (input.jsonSchema) {
    args.push('--json-schema', input.jsonSchema);
  }

  const disableSlash = input.disableSlashCommands ?? sub.agy_disable_slash_commands;
  if (disableSlash) {
    args.push('--disable-slash-commands');
  }

  const settings = input.settings ?? sub.agy_settings;
  if (settings) {
    args.push('--settings', settings);
  }

  if (input.timeoutSec) {
    args.push('--print-timeout', `${input.timeoutSec}s`);
  }

  return args;
}

export class PersistentSessionManager {
  private readonly sessions = new Map<string, LivePersistentSession>();
  private readonly idleTtlMs: number;

  constructor(idleTtlMs = DEFAULT_IDLE_TTL_MS) {
    this.idleTtlMs = idleTtlMs;
  }

  private bumpIdleTimer(session: LivePersistentSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.close(session.sessionId);
    }, this.idleTtlMs);
    session.idleTimer.unref?.();
  }

  private handleLine(session: LivePersistentSession, rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const ev = parsed as Record<string, unknown>;
    const eventType = typeof ev.event === 'string' ? ev.event : undefined;

    if (typeof ev.conversation_id === 'string') {
      session.conversationId = ev.conversation_id;
    }

    if (eventType === 'init' && ev.init && typeof ev.init === 'object') {
      const initObj = ev.init as Record<string, unknown>;
      if (typeof initObj.model === 'string') session.model = initObj.model;
      if (typeof initObj.permission_mode === 'string') {
        session.permissionMode = initObj.permission_mode;
      }
      session.lastActivityAt = new Date().toISOString();
    } else if (eventType === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
      const stepObj = ev.step_update as Record<string, unknown>;
      if (typeof stepObj.conversation_id === 'string') {
        session.conversationId = stepObj.conversation_id;
      }
      if (typeof stepObj.text_delta === 'string' && session.currentTurn) {
        session.currentTurn.textFragments.push(stepObj.text_delta);
      }
      const stepUsage = parseUsage(stepObj.usage);
      if (stepUsage) {
        session.usage = stepUsage;
      }
      session.lastActivityAt = new Date().toISOString();
    } else if (eventType === 'result' && ev.result && typeof ev.result === 'object') {
      const resObj = ev.result as Record<string, unknown>;
      if (typeof resObj.conversation_id === 'string') {
        session.conversationId = resObj.conversation_id;
      }
      if (typeof resObj.duration_seconds === 'number') {
        session.durationSeconds = resObj.duration_seconds;
      }
      if (typeof resObj.num_turns === 'number') {
        session.numTurns = resObj.num_turns;
      } else {
        session.numTurns += 1;
      }
      const usage = parseUsage(resObj.usage);
      if (usage) {
        session.usage = usage;
      }
      session.lastActivityAt = new Date().toISOString();

      const waiter = session.currentTurn;
      if (waiter) {
        clearTimeout(waiter.timer);
        session.currentTurn = undefined;
        session.busy = false;
        this.bumpIdleTimer(session);

        const responseText =
          typeof resObj.response === 'string'
            ? resObj.response
            : waiter.textFragments.join('');
        const status = typeof resObj.status === 'string' ? resObj.status : 'SUCCESS';
        const errorMessage = typeof resObj.error === 'string' ? resObj.error : undefined;

        waiter.resolve({
          status,
          response: responseText,
          structuredOutput: resObj.structured_output,
          errorMessage,
          metrics: {
            conversationId: session.conversationId,
            model: session.model,
            permissionMode: session.permissionMode,
            durationSeconds: session.durationSeconds,
            numTurns: session.numTurns,
            usage: session.usage,
          },
        });
      }
    }
  }

  public create(
    workspaceRoot: string,
    platform: NodeJS.Platform,
    child: ChildProcess,
    gitCheckpointRef?: string,
  ): LivePersistentSession {
    const sessionId = `ag-sess-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const idleTimer = setTimeout(() => {
      void this.close(sessionId);
    }, this.idleTtlMs);
    idleTimer.unref?.();

    const session: LivePersistentSession = {
      sessionId,
      workspaceRoot,
      platform,
      child,
      active: true,
      busy: false,
      numTurns: 0,
      durationSeconds: 0,
      gitCheckpointRef,
      createdAt: now,
      lastActivityAt: now,
      stdoutBuffer: '',
      stderrTail: '',
      idleTimer,
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      session.stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = session.stdoutBuffer.split(/\r?\n/);
      session.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        this.handleLine(session, line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const txt = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      session.stderrTail = `${session.stderrTail}${txt}`.slice(-4096);
    });

    child.once('close', (code) => {
      if (session.stdoutBuffer.trim()) {
        this.handleLine(session, session.stdoutBuffer);
        session.stdoutBuffer = '';
      }
      session.active = false;
      session.busy = false;
      clearTimeout(session.idleTimer);
      if (session.currentTurn) {
        const waiter = session.currentTurn;
        session.currentTurn = undefined;
        clearTimeout(waiter.timer);
        const detail = maskSecrets(session.stderrTail.trim().split(/\r?\n/).slice(-3).join(' '));
        waiter.reject(
          new Error(
            detail || `Antigravity stream session exited unexpectedly with code ${code ?? 'unknown'}.`,
          ),
        );
      }
      this.sessions.delete(sessionId);
    });

    child.once('error', (err) => {
      session.active = false;
      session.busy = false;
      clearTimeout(session.idleTimer);
      if (session.currentTurn) {
        const waiter = session.currentTurn;
        session.currentTurn = undefined;
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  public get(sessionId?: string, workspaceRoot?: string): LivePersistentSession | undefined {
    if (sessionId) {
      return this.sessions.get(sessionId);
    }
    let latest: LivePersistentSession | undefined;
    for (const s of this.sessions.values()) {
      if (!s.active) continue;
      if (workspaceRoot && path.resolve(s.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
      if (!latest || s.lastActivityAt > latest.lastActivityAt) {
        latest = s;
      }
    }
    return latest;
  }

  public summarize(session: LivePersistentSession): AgSessionSummary {
    return {
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      active: session.active,
      busy: session.busy,
      conversationId: session.conversationId,
      model: session.model,
      permissionMode: session.permissionMode,
      numTurns: session.numTurns,
      durationSeconds: session.durationSeconds,
      usage: session.usage,
      gitCheckpointRef: session.gitCheckpointRef,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    };
  }

  public list(workspaceRoot?: string): AgSessionSummary[] {
    const out: AgSessionSummary[] = [];
    for (const s of this.sessions.values()) {
      if (workspaceRoot && path.resolve(s.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
      out.push(this.summarize(s));
    }
    return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  public sendTurn(
    session: LivePersistentSession,
    prompt: string,
    timeoutSec = DEFAULT_TURN_TIMEOUT_SEC,
  ): Promise<TurnResult> {
    if (!session.active) {
      return Promise.reject(new Error(`Session "${session.sessionId}" is no longer active.`));
    }
    if (session.busy || session.currentTurn) {
      return Promise.reject(new Error('SESSION_BUSY'));
    }

    session.busy = true;
    session.lastActivityAt = new Date().toISOString();
    clearTimeout(session.idleTimer);

    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.currentTurn = undefined;
        session.busy = false;
        this.bumpIdleTimer(session);
        reject(new Error(`Session turn timed out after ${timeoutSec}s.`));
      }, Math.max(5, timeoutSec) * 1000);

      session.currentTurn = {
        resolve,
        reject,
        timer,
        textFragments: [],
      };

      try {
        const payload = JSON.stringify({
          event: 'user',
          message: { content: prompt },
        });
        session.child.stdin?.write(`${payload}\n`);
      } catch (err) {
        clearTimeout(timer);
        session.currentTurn = undefined;
        session.busy = false;
        this.bumpIdleTimer(session);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public async close(sessionId?: string, workspaceRoot?: string): Promise<AgSessionSummary | undefined> {
    const session = this.get(sessionId, workspaceRoot);
    if (!session) return undefined;

    const summary = this.summarize(session);
    summary.active = false;
    summary.busy = false;

    clearTimeout(session.idleTimer);
    this.sessions.delete(session.sessionId);

    if (session.active) {
      session.active = false;
      try {
        session.child.stdin?.end();
      } catch {
        // ignore
      }
      await Promise.race([
        new Promise<void>((r) => session.child.once('close', () => r())),
        new Promise<void>((r) => setTimeout(r, 800)),
      ]);
      killSessionProcess(session.child, session.platform);
    }

    return summary;
  }

  public disposeAll(): void {
    for (const s of [...this.sessions.values()]) {
      clearTimeout(s.idleTimer);
      try {
        s.child.stdin?.end();
      } catch {
        // ignore
      }
      killSessionProcess(s.child, s.platform);
    }
    this.sessions.clear();
  }
}

export const defaultSessionManager = new PersistentSessionManager();

export function disposePersistentSessions(): void {
  defaultSessionManager.disposeAll();
}

export async function handleAgSession(
  input: AgSessionToolInput,
  deps: SessionDependencies = {},
): Promise<AgSessionToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const manager = deps.sessionManager ?? defaultSessionManager;
  const warnings: string[] = [];

  if (input.action === 'list') {
    return {
      ok: true,
      action: 'list',
      sessions: manager.list(workspaceRoot),
      warnings,
    };
  }

  if (input.action === 'close') {
    const closed = await manager.close(input.sessionId, workspaceRoot);
    if (!closed) {
      return {
        ok: false,
        action: 'close',
        warnings,
        errorCode: 'SESSION_NOT_FOUND',
        errorMessage: input.sessionId
          ? `No active persistent session found for "${input.sessionId}".`
          : 'No active persistent Antigravity session in this workspace.',
      };
    }
    return {
      ok: true,
      action: 'close',
      sessionId: closed.sessionId,
      session: closed,
      warnings,
    };
  }

  if (input.action === 'send') {
    const prompt = input.prompt?.trim() ?? '';
    if (!prompt) {
      return {
        ok: false,
        action: 'send',
        warnings,
        errorCode: 'SESSION_FAILED',
        errorMessage: 'A non-empty `prompt` is required for action="send".',
      };
    }
    const session = manager.get(input.sessionId, workspaceRoot);
    if (!session) {
      return {
        ok: false,
        action: 'send',
        warnings,
        errorCode: 'SESSION_NOT_FOUND',
        errorMessage: input.sessionId
          ? `Session "${input.sessionId}" was not found or has already closed.`
          : 'No active persistent session found. Start one with `ag_session({ action: "start" })` or `/ag-session start`.',
      };
    }

    try {
      const turnRes = await manager.sendTurn(
        session,
        prompt,
        input.timeoutSec ?? DEFAULT_TURN_TIMEOUT_SEC,
      );
      const isOk = turnRes.status.toUpperCase() === 'SUCCESS';
      return {
        ok: isOk,
        action: 'send',
        sessionId: session.sessionId,
        session: manager.summarize(session),
        response: maskSecrets(turnRes.response),
        structuredOutput: turnRes.structuredOutput,
        metrics: turnRes.metrics,
        warnings,
        errorCode: isOk ? undefined : 'SESSION_FAILED',
        errorMessage: isOk
          ? undefined
          : maskSecrets(turnRes.errorMessage ?? `Turn finished with status=${turnRes.status}`),
      };
    } catch (err) {
      const msg = maskSecrets(err instanceof Error ? err.message : String(err));
      const isBusy = msg === 'SESSION_BUSY';
      return {
        ok: false,
        action: 'send',
        sessionId: session.sessionId,
        session: manager.summarize(session),
        warnings,
        errorCode: isBusy ? 'SESSION_BUSY' : 'SESSION_FAILED',
        errorMessage: isBusy
          ? `Session "${session.sessionId}" is currently executing another turn. Wait for it to finish.`
          : msg,
      };
    }
  }

  // action === 'start'
  const detDeps = deps.detectorDeps ?? getDefaultDetectorDeps();
  const config = loadConfig(workspaceRoot, detDeps.env);
  const detection = detectEnvironment(config, 'subscription', detDeps);

  if (!detection.subscription.detected || detection.subscription.cliBinary !== 'agy' || !detection.subscription.cliPath) {
    return {
      ok: false,
      action: 'start',
      warnings,
      errorCode: 'AGY_CLI_NOT_FOUND',
      errorMessage:
        'Persistent stream-json sessions require the local Antigravity CLI (`agy`). Install `agy` and run `/ag-login`.',
    };
  }

  const skipPerm =
    input.dangerouslySkipPermissions ?? config.subscription.agy_dangerously_skip_permissions;
  if (skipPerm) {
    warnings.push(
      'Persistent session started with `--dangerously-skip-permissions` (permission_mode=always-proceed).',
    );
  }

  const checkpointTaskId = generateTaskId();
  const checkpoint = createCheckpoint(workspaceRoot, checkpointTaskId, config.git_guard);
  if (checkpoint.warning) {
    warnings.push(checkpoint.warning);
  }

  const args = buildStreamSessionArgs(input, config);
  const spec = buildCliSpawnSpec(detection.subscription.cliPath, args, detection.platform);
  const spawnFn = deps.spawnFn ?? defaultSessionSpawn;

  let child: ChildProcess;
  try {
    child = spawnFn(spec.command, spec.args, {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: spec.windowsHide,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (err) {
    const msg = maskSecrets(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      action: 'start',
      warnings,
      errorCode: 'SESSION_FAILED',
      errorMessage: `Failed to start persistent agy session: ${msg}`,
    };
  }

  const session = manager.create(
    workspaceRoot,
    detection.platform,
    child,
    checkpoint.checkpointRef,
  );

  // If caller provided an initial prompt, execute Turn 1 immediately so session warms up & returns response
  if (input.prompt && input.prompt.trim().length > 0) {
    try {
      const turnRes = await manager.sendTurn(
        session,
        input.prompt.trim(),
        input.timeoutSec ?? DEFAULT_TURN_TIMEOUT_SEC,
      );
      const isOk = turnRes.status.toUpperCase() === 'SUCCESS';
      return {
        ok: isOk,
        action: 'start',
        sessionId: session.sessionId,
        session: manager.summarize(session),
        response: maskSecrets(turnRes.response),
        structuredOutput: turnRes.structuredOutput,
        metrics: turnRes.metrics,
        warnings,
        errorCode: isOk ? undefined : 'SESSION_FAILED',
        errorMessage: isOk
          ? undefined
          : maskSecrets(turnRes.errorMessage ?? `Initial turn finished with status=${turnRes.status}`),
      };
    } catch (err) {
      const msg = maskSecrets(err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        action: 'start',
        sessionId: session.sessionId,
        session: manager.summarize(session),
        warnings,
        errorCode: 'SESSION_FAILED',
        errorMessage: msg,
      };
    }
  }

  return {
    ok: true,
    action: 'start',
    sessionId: session.sessionId,
    session: manager.summarize(session),
    warnings,
  };
}
