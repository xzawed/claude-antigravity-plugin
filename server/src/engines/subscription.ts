import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { requireExecutable, windowsShell } from '../exec-path.js';
import {
  getArtifactsDir,
  getBridgeDir,
  listTaskArtifacts,
  readManifest,
  readReportMarkdown,
  syncHandoffTemplate,
  writeManifest,
  writeReportMarkdown,
} from '../bridge-fs.js';
import { maskSecrets } from '../config.js';
import { listGitChangedFiles } from '../git-guard.js';
import {
  AgyModelInfo,
  BridgeManifest,
  ExecutionMetrics,
  TokenUsage,
} from '../types.js';
import {
  ExecutionContext,
  ExecutionEngine,
  ExecutionProgressEvent,
  ExecutionResult,
} from './base.js';

export interface StreamCaptureState {
  metrics: ExecutionMetrics;
  resultReceived: boolean;
  resultStatus?: string;
  resultResponse?: string;
  structuredOutput?: unknown;
  errorMessage?: string;
}

export interface TriggerOutcome {
  methodUsed: 'cli' | 'ipc' | 'clipboard' | 'custom';
  warning?: string;
  streamState?: StreamCaptureState;
  stopStream?: () => void;
  killProcess?: () => void;
  processExitPromise?: Promise<number | null>;
}

/**
 * Terminate a spawned child process and its descendant process tree across platforms.
 * On Windows uses `taskkill /T /F`; on POSIX sends `SIGTERM` to the child's process group
 * (`-pid`, assuming `detached: true`) and optionally escalates to `SIGKILL` if still alive.
 */
export function killChildProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  options?: { escalateToSigkillMs?: number },
): void {
  if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') {
    return;
  }
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return;
  }
  try {
    if (platform === 'win32') {
      execFileSync(requireExecutable('taskkill'), ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const escalateMs = options?.escalateToSigkillMs ?? 2000;
      if (escalateMs > 0) {
        const timer = setTimeout(() => {
          if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') return;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }, escalateMs);
        timer.unref?.();
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

export type TriggerFn = (ctx: ExecutionContext) => Promise<TriggerOutcome>;

export interface SubscriptionEngineOptions {
  triggerFn?: TriggerFn;
}

const NATIVE_AGY_SLASH_RE =
  /^\/(boost|browser|swarm|goal|teamwork|grill-me|plan|btw|compact|codesearch|learn|schedule)\b/i;

export function buildHandoffPrompt(ctx: ExecutionContext): string {
  const disableSlash =
    ctx.agyOptions?.disableSlashCommands ?? ctx.config.subscription.agy_disable_slash_commands;
  const trimmedInstructions = ctx.instructions.trim();

  // Preserve native Antigravity CLI power slash commands (/boost, /browser, /swarm, /goal, etc.)
  // or explicit rawPrompt verbatim so Antigravity expands them directly.
  if (
    ctx.agyOptions?.rawPrompt ||
    (!disableSlash && NATIVE_AGY_SLASH_RE.test(trimmedInstructions))
  ) {
    return trimmedInstructions;
  }

  // If the user disabled slash commands, is resuming an existing conversation,
  // requested structured JSON output, or is running read-only plan mode (e.g. /ag-review),
  // send direct instructions while referencing .ag-bridge/dispatch.md for context.
  if (
    disableSlash ||
    ctx.agyOptions?.continueConversation ||
    ctx.agyOptions?.conversationId ||
    ctx.agyOptions?.jsonSchema ||
    ctx.agyOptions?.agyMode === 'plan'
  ) {
    return `${trimmedInstructions}\n\n(Delegated task ID: ${ctx.manifest.taskId}. Bridge context is also saved in .ag-bridge/dispatch.md.)`;
  }

  return `/claude-handoff Execute delegated task ${ctx.manifest.taskId} from .ag-bridge/dispatch.md and update .ag-bridge/manifest.json and .ag-bridge/report.md when done.`;
}

// Helper programs are launched by absolute path (exec-path.ts): requireExecutable throws where a
// bare name would have failed with ENOENT, so each existing catch keeps its meaning.
function tryCopyToClipboard(text: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'darwin') {
      execFileSync(requireExecutable('pbcopy'), [], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      return true;
    }
    if (platform === 'win32') {
      execFileSync(requireExecutable('clip'), [], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      return true;
    }
    try {
      execFileSync(requireExecutable('xclip'), ['-selection', 'clipboard'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      return true;
    } catch {
      execFileSync(requireExecutable('wl-copy'), [], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      return true;
    }
  } catch {
    return false;
  }
}

function tryDesktopNotify(title: string, message: string, platform: NodeJS.Platform): void {
  try {
    if (platform === 'darwin') {
      const escapedMsg = message.replace(/"/g, '\\"');
      const escapedTitle = title.replace(/"/g, '\\"');
      execFileSync(
        requireExecutable('osascript'),
        ['-e', `display notification "${escapedMsg}" with title "${escapedTitle}"`],
        { stdio: 'ignore', timeout: 3000 },
      );
    } else if (platform === 'linux') {
      execFileSync(requireExecutable('notify-send'), [title, message], { stdio: 'ignore', timeout: 3000 });
    }
  } catch {
    // Best-effort notification only
  }
}

function parseUsageObject(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = Number(u.input_tokens ?? u.inputTokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? u.outputTokens ?? 0);
  const thinkingTokens = Number(u.thinking_tokens ?? u.thinkingTokens ?? 0);
  const cacheReadTokens = Number(u.cache_read_tokens ?? u.cacheReadTokens ?? 0);
  const totalTokens = Number(
    u.total_tokens ?? u.totalTokens ?? inputTokens + outputTokens + thinkingTokens,
  );
  if (
    Number.isNaN(inputTokens) &&
    Number.isNaN(outputTokens) &&
    Number.isNaN(totalTokens)
  ) {
    return undefined;
  }
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    thinkingTokens: Number.isFinite(thinkingTokens) ? thinkingTokens : 0,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

export function formatTokenUsageMarkdown(metrics?: ExecutionMetrics): string {
  if (!metrics?.usage && !metrics?.conversationId && metrics?.durationSeconds === undefined) {
    return '';
  }
  const lines: string[] = ['## Execution Metrics & Token Usage'];
  if (metrics.model) lines.push(`- **Model:** \`${metrics.model}\``);
  if (metrics.conversationId) lines.push(`- **Conversation ID:** \`${metrics.conversationId}\``);
  if (metrics.permissionMode) lines.push(`- **Permission Mode:** \`${metrics.permissionMode}\``);
  if (metrics.numTurns !== undefined) lines.push(`- **Turns:** ${metrics.numTurns}`);
  if (metrics.durationSeconds !== undefined) {
    lines.push(`- **Duration:** ${metrics.durationSeconds.toFixed(2)}s`);
  }
  if (metrics.usage) {
    const u = metrics.usage;
    lines.push(
      `- **Tokens:** total \`${u.totalTokens.toLocaleString()}\` (input: \`${u.inputTokens.toLocaleString()}\`, output: \`${u.outputTokens.toLocaleString()}\`, thinking: \`${u.thinkingTokens.toLocaleString()}\`, cache read: \`${u.cacheReadTokens.toLocaleString()}\`)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function safeEmitProgress(ctx: ExecutionContext, event: ExecutionProgressEvent): void {
  if (!ctx.onProgress) return;
  try {
    ctx.onProgress({
      progress: event.progress,
      ...(event.total !== undefined ? { total: event.total } : {}),
      message: maskSecrets(event.message),
    });
  } catch {
    // Best-effort notification: never fail delegation on progress callback error
  }
}

export function formatStreamEventProgress(
  ev: Record<string, unknown>,
  stepCount: number,
): ExecutionProgressEvent | null {
  const eventType = typeof ev.event === 'string' ? ev.event : undefined;
  if (eventType === 'init' && ev.init && typeof ev.init === 'object') {
    const initObj = ev.init as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof initObj.model === 'string') parts.push(`model=${initObj.model}`);
    if (typeof initObj.permission_mode === 'string') parts.push(`mode=${initObj.permission_mode}`);
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return {
      progress: stepCount,
      message: `Antigravity session initialized${suffix}`,
    };
  }
  if (eventType === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
    const stepObj = ev.step_update as Record<string, unknown>;
    const label =
      (typeof stepObj.title === 'string' && stepObj.title.trim()) ||
      (typeof stepObj.summary === 'string' && stepObj.summary.trim()) ||
      (typeof stepObj.tool_name === 'string' && `tool:${stepObj.tool_name.trim()}`) ||
      (typeof stepObj.step_type === 'string' && stepObj.step_type.trim()) ||
      (typeof stepObj.status === 'string' && stepObj.status.trim()) ||
      'working';
    const usage = parseUsageObject(stepObj.usage);
    const tokenNote = usage && usage.totalTokens > 0 ? ` (${usage.totalTokens} tokens)` : '';
    return {
      progress: stepCount,
      message: `Step ${stepCount}: ${maskSecrets(label).slice(0, 160)}${tokenNote}`,
    };
  }
  if (eventType === 'result' && ev.result && typeof ev.result === 'object') {
    const resObj = ev.result as Record<string, unknown>;
    const status = typeof resObj.status === 'string' ? resObj.status : 'DONE';
    const turns = typeof resObj.num_turns === 'number' ? `, turns=${resObj.num_turns}` : '';
    const usage = parseUsageObject(resObj.usage);
    const tokens = usage && usage.totalTokens > 0 ? `, tokens=${usage.totalTokens}` : '';
    return {
      progress: stepCount,
      total: stepCount,
      message: `Antigravity finished (status=${status}${turns}${tokens})`,
    };
  }
  return null;
}

export interface StreamHeartbeatOptions {
  workspaceRoot: string;
  taskId: string;
  logFilePath?: string;
  minHeartbeatIntervalMs?: number;
  autoFinalizeOnResult?: boolean;
  onEvent?: (event: Record<string, unknown>) => void;
}

export function attachStreamJsonHeartbeat(
  stream: Readable,
  options: StreamHeartbeatOptions,
): { stop: () => void; state: StreamCaptureState } {
  const minInterval = options.minHeartbeatIntervalMs ?? 2000;
  let buffer = '';
  let lastBeatMs = 0;
  let stopped = false;

  const state: StreamCaptureState = {
    metrics: {},
    resultReceived: false,
  };

  const appendLog = (line: string): void => {
    if (!options.logFilePath) return;
    try {
      fs.mkdirSync(path.dirname(options.logFilePath), { recursive: true });
      fs.appendFileSync(options.logFilePath, `${maskSecrets(line)}\n`, 'utf8');
    } catch {
      // ignore non-fatal log write failure
    }
  };

  const maybeBeatManifest = (): void => {
    const nowMs = Date.now();
    if (nowMs - lastBeatMs < minInterval) {
      return;
    }
    try {
      const current = readManifest(options.workspaceRoot);
      if (!current || current.taskId !== options.taskId) {
        return;
      }
      // Never overwrite terminal VERIFIED or FAILED statuses
      if (current.status !== 'DISPATCHED' && current.status !== 'RUNNING') {
        return;
      }
      lastBeatMs = nowMs;
      writeManifest(options.workspaceRoot, {
        ...current,
        status: 'RUNNING',
        metrics: { ...(current.metrics ?? {}), ...state.metrics },
        updatedAt: new Date(nowMs).toISOString(),
      });
    } catch {
      // ignore transient manifest lock errors
    }
  };

  const handleStreamResult = (resultObj: Record<string, unknown>): void => {
    state.resultReceived = true;
    const convId = typeof resultObj.conversation_id === 'string' ? resultObj.conversation_id : undefined;
    const status = typeof resultObj.status === 'string' ? resultObj.status : undefined;
    const response = typeof resultObj.response === 'string' ? resultObj.response : undefined;
    const duration =
      typeof resultObj.duration_seconds === 'number' ? resultObj.duration_seconds : undefined;
    const numTurns = typeof resultObj.num_turns === 'number' ? resultObj.num_turns : undefined;
    const usage = parseUsageObject(resultObj.usage);

    if (convId) state.metrics.conversationId = convId;
    if (duration !== undefined) state.metrics.durationSeconds = duration;
    if (numTurns !== undefined) state.metrics.numTurns = numTurns;
    if (usage) state.metrics.usage = usage;
    state.resultStatus = status;
    state.resultResponse = response;
    if (resultObj.structured_output !== undefined) {
      state.structuredOutput = resultObj.structured_output;
    }
    if (typeof resultObj.error === 'string') {
      state.errorMessage = resultObj.error;
    }

    if (!options.autoFinalizeOnResult) {
      return;
    }

    try {
      const current = readManifest(options.workspaceRoot);
      if (!current || current.taskId !== options.taskId) {
        return;
      }

      // If /claude-handoff already finalized manifest.json, just enrich it with metrics
      if (current.status === 'VERIFIED' || current.status === 'FAILED') {
        writeManifest(options.workspaceRoot, {
          ...current,
          metrics: { ...(current.metrics ?? {}), ...state.metrics },
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      const isSuccess = status?.toUpperCase() === 'SUCCESS';
      const finalStatus = isSuccess ? 'VERIFIED' : 'FAILED';
      const existingReport = readReportMarkdown(options.workspaceRoot);
      if (!existingReport) {
        const usageBlock = formatTokenUsageMarkdown(state.metrics);
        const autoReport = [
          '# Antigravity Task Report',
          '',
          `- **Task ID:** \`${options.taskId}\``,
          `- **Status:** ${finalStatus}`,
          '- **Engine:** subscription (`agy`)',
          `- **Completed At:** \`${new Date().toISOString()}\``,
          '',
          '## Response',
          maskSecrets(response?.trim() || state.errorMessage || '(No response text emitted.)'),
          '',
          usageBlock,
        ].join('\n');
        writeReportMarkdown(options.workspaceRoot, autoReport);
      }

      writeManifest(options.workspaceRoot, {
        ...current,
        status: finalStatus,
        metrics: { ...(current.metrics ?? {}), ...state.metrics },
        errorCode: isSuccess ? undefined : 'INTERNAL_ERROR',
        error: isSuccess
          ? undefined
          : maskSecrets(state.errorMessage ?? `agy CLI finished with status=${status ?? 'UNKNOWN'}`),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore transient error
    }
  };

  const processLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    appendLog(trimmed);

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      const ev = parsed as Record<string, unknown>;
      options.onEvent?.(ev);

      const eventType = typeof ev.event === 'string' ? ev.event : undefined;
      if (typeof ev.conversation_id === 'string') {
        state.metrics.conversationId = ev.conversation_id;
      }

      if (eventType === 'init' && ev.init && typeof ev.init === 'object') {
        const initObj = ev.init as Record<string, unknown>;
        if (typeof initObj.model === 'string') state.metrics.model = initObj.model;
        if (typeof initObj.permission_mode === 'string') {
          state.metrics.permissionMode = initObj.permission_mode;
        }
        maybeBeatManifest();
      } else if (eventType === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
        const stepObj = ev.step_update as Record<string, unknown>;
        if (typeof stepObj.conversation_id === 'string') {
          state.metrics.conversationId = stepObj.conversation_id;
        }
        const stepUsage = parseUsageObject(stepObj.usage);
        if (stepUsage) {
          state.metrics.usage = stepUsage;
        }
        maybeBeatManifest();
      } else if (eventType === 'result' && ev.result && typeof ev.result === 'object') {
        handleStreamResult(ev.result as Record<string, unknown>);
      } else {
        // Generic JSON event (compatibility with custom stream formats)
        const genericUsage = parseUsageObject(ev.usage);
        if (genericUsage) {
          state.metrics.usage = genericUsage;
        }
        maybeBeatManifest();
      }
    } catch {
      // Non-JSON diagnostic lines are still logged but do not break stream parsing
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  };

  const onEnd = (): void => {
    if (stopped) return;
    if (buffer.trim()) {
      processLine(buffer);
      buffer = '';
    }
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  return {
    state,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
    },
  };
}

export function buildCliInvocationArgs(ctx: ExecutionContext): string[] {
  const { cliBinary } = ctx.detection.subscription;
  const prompt = buildHandoffPrompt(ctx);

  if (cliBinary === 'agy') {
    const sub = ctx.config.subscription;
    const opts = ctx.agyOptions ?? {};
    const timeoutSec = ctx.timeoutSecOverride ?? sub.timeout_sec;

    const args: string[] = ['--print', prompt];

    const skipPermissions =
      opts.dangerouslySkipPermissions ?? sub.agy_dangerously_skip_permissions;

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
      // Only also pass --mode if the caller explicitly requested a mode override
      if (opts.agyMode) {
        args.push('--mode', opts.agyMode);
      }
    } else {
      const mode = opts.agyMode ?? sub.agy_mode;
      args.push('--mode', mode);
    }

    const useSandbox = opts.sandbox ?? sub.agy_sandbox;
    if (useSandbox) {
      args.push('--sandbox');
    }

    const model = opts.model ?? sub.agy_model;
    if (model) {
      args.push('--model', model);
    }

    const effort = opts.effort ?? sub.agy_effort;
    if (effort) {
      args.push('--effort', effort);
    }

    const agent = opts.agent ?? sub.agy_agent;
    if (agent) {
      args.push('--agent', agent);
    }

    if (opts.addDirs && opts.addDirs.length > 0) {
      for (const dir of opts.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    if (opts.conversationId) {
      args.push('--conversation', opts.conversationId);
    } else if (opts.continueConversation) {
      args.push('--continue');
    }

    const project = opts.project ?? sub.agy_project;
    if (project) {
      args.push('--project', project);
    }

    if (opts.newProject) {
      args.push('--new-project');
    }

    const remoteAgent = opts.remoteAgent ?? sub.agy_remote_agent;
    if (remoteAgent) {
      args.push('--remote-agent');
    }

    if (opts.jsonSchema) {
      args.push('--json-schema', opts.jsonSchema);
    }

    const disableSlash = opts.disableSlashCommands ?? sub.agy_disable_slash_commands;
    if (disableSlash) {
      args.push('--disable-slash-commands');
    }

    const settings = opts.settings ?? sub.agy_settings;
    if (settings) {
      args.push('--settings', settings);
    }

    args.push('--print-timeout', `${timeoutSec}s`);

    if (sub.agy_stream_heartbeat) {
      args.push('--output-format', 'stream-json');
    }

    return args;
  }

  return ['run', '--workflow', 'claude-handoff'];
}

function quoteForWindowsCmd(arg: string): string {
  // Neutralize both cmd.exe /c pass-1 AND batch `%*` pass-2 metacharacters + `%VAR%` expansion:
  // - Inside "...", doubling `"` -> `""` keeps quote state balanced across both cmd.exe passes
  //   (preventing `" & cmd` breakout) and decodes to a single literal `"` in CommandLineToArgvW.
  // - Backslashes immediately before `"` or end-of-chunk are doubled so C-runtime parsing matches.
  // - Splitting on `%` and joining with `^%` prevents `%VAR%` expansion in cmd.exe /c while
  //   passing a literal `%` through batch `%*` without re-expansion (empirically verified on Win11).
  const sanitized = arg.replace(/[\r\n\0]+/g, ' ');
  const chunks = sanitized.split('%').map((chunk) => {
    if (chunk.length === 0) return '';
    const escaped = chunk
      .replace(/(\\*)"/g, '$1$1""')
      .replace(/(\\+)$/, '$1$1');
    return `"${escaped}"`;
  });
  const joined = chunks.join('^%');
  return joined.length === 0 ? '""' : joined;
}

export function buildCliSpawnSpec(
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsHide: boolean; windowsVerbatimArguments?: boolean } {
  // Node.js 20.12+/24 on Windows throws EINVAL when spawning .cmd/.bat with shell: false.
  // Wrapping the full command line in outer quotes for `cmd.exe /d /s /c` with
  // windowsVerbatimArguments preserves paths containing spaces (e.g. "C:\Program Files\...")
  // as well as multi-word arguments. The interpreter itself is an absolute path (TC-S15).
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const innerCmd = [quoteForWindowsCmd(cliPath), ...args.map(quoteForWindowsCmd)].join(' ');
    return {
      command: windowsShell(env),
      args: ['/d', '/s', '/c', `"${innerCmd}"`],
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: cliPath,
    args,
    windowsHide: true,
  };
}

export function parseAgyModelsOutput(raw: string): AgyModelInfo[] {
  const models: AgyModelInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^fetching\s+/i.test(trimmed)) continue;
    const tabParts = trimmed.split('\t').map((s) => s.trim()).filter(Boolean);
    if (tabParts.length >= 2) {
      models.push({ id: tabParts[0], label: tabParts.slice(1).join(' ') });
      continue;
    }
    const spaceMatch = trimmed.match(/^([a-z0-9._-]+)\s{2,}(.+)$/i);
    if (spaceMatch) {
      models.push({ id: spaceMatch[1], label: spaceMatch[2].trim() });
    }
  }
  return models;
}

export function parseAgyAgentsOutput(raw: string): string[] {
  const agents: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(fetching|no\s+agents|available\s+agents)/i.test(trimmed)) continue;
    const first = trimmed.split(/\s+/)[0];
    if (first) agents.push(first);
  }
  return agents;
}

// Exactly the measured answer, nothing after it, and no parenthesis inside the list: a greedy `(.*)`
// read "(available: a, b) (hint)" as ["a", "b) (hint"] (both review legs). Anything else is not read.
const AGENT_PROBE_ANSWER = /unknown agent "[^"]*" \((?:available: ([^()]*)|no custom agents are available)\)/;

/**
 * The agents agy names when asked for one it does not have, or undefined when `output` is not that
 * answer. `agy agents` prints nothing unless its output is a terminal (measured: 0 bytes through a
 * pipe or a file); the unknown-agent error lists the agents before any session starts (measured:
 * conversation_id "", 0 tokens, no workspace hook ran). A name holding ", " cannot be told apart.
 */
export function parseAgyAgentProbe(output: string): string[] | undefined {
  const names = (list: string | undefined): string[] =>
    list === undefined ? [] : list.split(', ').map((n) => n.trim()).filter((n) => n.length > 0);
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { event?: unknown; result?: Record<string, unknown> };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    const result = event.result;
    if (event.event !== 'result' || !result) continue;
    // an answer that started a session is never a listing
    if (result.status !== 'ERROR' || (result.num_turns ?? 0) !== 0 || (result.conversation_id ?? '') !== '') {
      return undefined;
    }
    const m = new RegExp(`^${AGENT_PROBE_ANSWER.source}$`).exec(String(result.error ?? '').trim());
    return m ? names(m[1]) : undefined;
  }
  const m = new RegExp(`^error: ${AGENT_PROBE_ANSWER.source}\\s*$`, 'm').exec(output);
  return m ? names(m[1]) : undefined;
}

export interface AgyCapabilityQuery {
  /** Where agy runs: its agents include the ones the workspace defines (.agents/agents/). */
  cwd?: string;
  /** When `agy agents` prints nothing, ask agy for an agent it does not have (list_ag_capabilities). */
  probeAgents?: boolean;
}

export async function queryAgyCapabilities(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
  query: AgyCapabilityQuery = {},
): Promise<{ models: AgyModelInfo[]; agents: string[]; warnings: string[] }> {
  const warnings: string[] = [];

  const runSub = (subArgs: string[], expectFailure = false): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const spec = buildCliSpawnSpec(cliPath, subArgs, platform);
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr });
        }
      };

      try {
        const MAX_CAP_OUTPUT = 2 * 1024 * 1024;
        const child = spawn(spec.command, spec.args, {
          cwd: query.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: platform !== 'win32',
          shell: false,
          windowsHide: spec.windowsHide,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });

        const timer = setTimeout(() => {
          warnings.push(`Timed out querying \`agy ${subArgs.join(' ')}\` after 15s.`);
          killChildProcessTree(child, platform);
          finish();
        }, 15_000);

        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (stdout.length < MAX_CAP_OUTPUT) {
            stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (stderr.length < MAX_CAP_OUTPUT) {
            stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          }
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          warnings.push(`Failed to query \`agy ${subArgs.join(' ')}\`: ${err.message}`);
          stdout = '';
          stderr = '';
          finish();
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (!expectFailure && code !== 0 && code !== null) {
            const errText = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
            if (errText) {
              warnings.push(`\`agy ${subArgs.join(' ')}\` exited ${code}: ${maskSecrets(errText)}`);
            }
          }
          finish();
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to query \`agy ${subArgs.join(' ')}\`: ${msg}`);
        finish();
      }
    });

  // A random name no agent can have; plan mode and a print time limit in case an agy release ever
  // runs a session for an unknown agent again (fixed in agy: such runs now exit 1).
  const probeArgs = [
    '-p',
    'List the available agents.',
    '--agent',
    `__ag_bridge_agent_probe_${randomBytes(6).toString('hex')}__`,
    '--mode',
    'plan',
    '--output-format',
    'stream-json',
    '--print-timeout',
    '10s',
  ];
  const [modelsOut, agentsOut, probeOut] = await Promise.all([
    runSub(['models']),
    runSub(['agents']),
    query.probeAgents ? runSub(probeArgs, true) : Promise.resolve(undefined),
  ]);
  const models = parseAgyModelsOutput(modelsOut.stdout);
  let agents = parseAgyAgentsOutput(agentsOut.stdout);
  if (agents.length === 0 && probeOut) {
    const probed = parseAgyAgentProbe(`${probeOut.stdout}\n${probeOut.stderr}`);
    if (probed) {
      agents = probed;
    } else {
      warnings.push('Could not read the agent list: `agy agents` printed nothing and agy did not name its agents when asked for an unknown one.');
    }
  }

  return { models, agents, warnings };
}

async function tryCliTrigger(
  ctx: ExecutionContext,
): Promise<{
  ok: boolean;
  streamState?: StreamCaptureState;
  stopStream?: () => void;
  killProcess?: () => void;
  processExitPromise?: Promise<number | null>;
}> {
  const { cliBinary, cliPath } = ctx.detection.subscription;
  if (!cliPath) {
    return { ok: false };
  }

  const args = buildCliInvocationArgs(ctx);
  const spawnSpec = buildCliSpawnSpec(cliPath, args, ctx.detection.platform);
  const useStreamHeartbeat =
    cliBinary === 'agy' && ctx.config.subscription.agy_stream_heartbeat;

  const artDir = getArtifactsDir(ctx.workspaceRoot, ctx.manifest.taskId);
  const logFilePath = path.join(artDir, 'agy-cli.log');

  let logFd: number | null = null;
  if (!useStreamHeartbeat) {
    try {
      fs.mkdirSync(artDir, { recursive: true });
      logFd = fs.openSync(logFilePath, 'a');
    } catch {
      logFd = null;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let resolveExit!: (code: number | null) => void;
    const processExitPromise = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const closeLogFd = (): void => {
      if (logFd !== null) {
        try {
          fs.closeSync(logFd);
        } catch {
          // ignore
        }
        logFd = null;
      }
    };

    try {
      const isWin = ctx.detection.platform === 'win32';
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: ctx.workspaceRoot,
        stdio: useStreamHeartbeat
          ? ['ignore', 'pipe', 'pipe']
          : logFd !== null
            ? ['ignore', logFd, logFd]
            : 'ignore',
        // On POSIX, detached makes child a process-group leader so process.kill(-pid) reaps
        // grandchildren too; we only unref() when not streaming stdout.
        detached: !isWin || !useStreamHeartbeat,
        shell: false,
        windowsHide: spawnSpec.windowsHide,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      });

      // Child inherited logFd; close parent descriptor immediately
      closeLogFd();

      const killProcess = (): void => {
        if (exited) return;
        killChildProcessTree(child, ctx.detection.platform, { escalateToSigkillMs: 2000 });
      };

      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) {
          killProcess();
        } else {
          ctx.abortSignal.addEventListener('abort', killProcess, { once: true });
        }
      }

      let heartbeatHandle: { stop: () => void; state: StreamCaptureState } | null = null;
      let streamStepCount = 0;
      if (useStreamHeartbeat && child.stdout) {
        heartbeatHandle = attachStreamJsonHeartbeat(child.stdout, {
          workspaceRoot: ctx.workspaceRoot,
          taskId: ctx.manifest.taskId,
          logFilePath,
          autoFinalizeOnResult: true,
          onEvent: (ev) => {
            const eventType = typeof ev.event === 'string' ? ev.event : undefined;
            if (eventType === 'init' || eventType === 'step_update' || eventType === 'result') {
              streamStepCount += 1;
              const progressEvent = formatStreamEventProgress(ev, streamStepCount);
              if (progressEvent) {
                safeEmitProgress(ctx, progressEvent);
              }
            }
          },
        });
      }
      if (useStreamHeartbeat && child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          try {
            fs.mkdirSync(artDir, { recursive: true });
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            fs.appendFileSync(logFilePath, maskSecrets(text), 'utf8');
          } catch {
            // ignore
          }
        });
      }

      const cleanupAbortListener = (): void => {
        ctx.abortSignal?.removeEventListener('abort', killProcess);
      };

      child.once('error', () => {
        exited = true;
        cleanupAbortListener();
        heartbeatHandle?.stop();
        resolveExit(null);
        if (!settled) {
          settled = true;
          resolve({ ok: false });
        }
      });

      // Use 'close' (not 'exit') so stdout has fully flushed and emitted 'end' before
      // heartbeatHandle.stop() detaches listeners — prevents losing the final result JSON line.
      child.once('close', (code) => {
        exited = true;
        cleanupAbortListener();
        heartbeatHandle?.stop();
        resolveExit(code);
        if (!settled) {
          settled = true;
          resolve({
            ok: code === 0,
            streamState: heartbeatHandle?.state,
            stopStream: heartbeatHandle?.stop,
            killProcess,
            processExitPromise,
          });
        }
      });

      // If process stays alive briefly without immediate spawn/arg failure, treat as launched
      setTimeout(() => {
        if (!settled) {
          settled = true;
          if (!useStreamHeartbeat) {
            try {
              child.unref();
            } catch {
              // ignore
            }
          }
          resolve({
            ok: true,
            streamState: heartbeatHandle?.state,
            stopStream: heartbeatHandle?.stop,
            killProcess,
            processExitPromise,
          });
        }
      }, 400).unref();
    } catch {
      closeLogFd();
      resolveExit(null);
      if (!settled) {
        settled = true;
        resolve({ ok: false });
      }
    }
  });
}

function tryOsIpcTrigger(ctx: ExecutionContext): boolean {
  const platform = ctx.detection.platform;
  const prompt = buildHandoffPrompt(ctx);
  try {
    if (platform === 'darwin') {
      tryCopyToClipboard(prompt, platform);
      execFileSync(requireExecutable('osascript'), ['-e', 'tell application "Antigravity" to activate'], {
        stdio: 'ignore',
        timeout: 3000,
      });
      return true;
    }
    if (platform === 'win32') {
      tryCopyToClipboard(prompt, platform);
      execFileSync(
        requireExecutable('powershell'),
        [
          '-NoProfile',
          '-Command',
          '$ws = New-Object -ComObject WScript.Shell; $null = $ws.AppActivate("Antigravity")',
        ],
        { stdio: 'ignore', timeout: 3000 },
      );
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function defaultSubscriptionTrigger(ctx: ExecutionContext): Promise<TriggerOutcome> {
  if (ctx.abortSignal?.aborted) {
    return { methodUsed: 'cli' };
  }
  const method = ctx.config.subscription.trigger_method;
  const prompt = buildHandoffPrompt(ctx);

  if (method === 'cli_only' || method === 'cli_or_ipc') {
    const cliRes = await tryCliTrigger(ctx);
    if (cliRes.ok) {
      return {
        methodUsed: 'cli',
        streamState: cliRes.streamState,
        stopStream: cliRes.stopStream,
        killProcess: cliRes.killProcess,
        processExitPromise: cliRes.processExitPromise,
      };
    }
    if (ctx.abortSignal?.aborted) {
      return { methodUsed: 'cli' };
    }
    if (method === 'cli_only') {
      return {
        methodUsed: 'cli',
        warning:
          'CLI trigger exited early or was unavailable; waiting on .ag-bridge/manifest.json in case Antigravity is running manually.',
      };
    }
  }

  if (ctx.abortSignal?.aborted) {
    return { methodUsed: 'cli' };
  }

  if (method === 'cli_or_ipc') {
    const ipcOk = tryOsIpcTrigger(ctx);
    if (ipcOk) {
      return {
        methodUsed: 'ipc',
        warning:
          'Activated Antigravity window and copied `/claude-handoff` command to clipboard. Paste into Antigravity if not auto-submitted.',
      };
    }
  }

  const copied = tryCopyToClipboard(prompt, ctx.detection.platform);
  tryDesktopNotify(
    'Antigravity Handoff Ready',
    `Task ${ctx.manifest.taskId} dispatched. Run /claude-handoff in Antigravity.`,
    ctx.detection.platform,
  );

  return {
    methodUsed: 'clipboard',
    warning: copied
      ? 'Copied `/claude-handoff` prompt to clipboard. Paste it into your Antigravity session to execute this task.'
      : 'Run `/claude-handoff` inside your Antigravity session for this workspace to execute the dispatched task.',
  };
}

function waitForManifestCompletion(
  workspaceRoot: string,
  taskId: string,
  timeoutSec: number,
  pollIntervalMs: number,
  abortSignal?: AbortSignal,
  processExitPromise?: Promise<number | null>,
): Promise<{
  timedOut: boolean;
  cancelled: boolean;
  processExitedEarly: boolean;
  exitCode?: number | null;
  manifest: BridgeManifest | null;
}> {
  return new Promise((resolve) => {
    let finished = false;
    let watcher: fs.FSWatcher | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let exitGraceTimer: NodeJS.Timeout | null = null;

    const safeReadManifest = (): BridgeManifest | null => {
      try {
        return readManifest(workspaceRoot);
      } catch {
        return null;
      }
    };

    const cleanup = (): void => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }
    };

    const done = (result: {
      timedOut: boolean;
      cancelled: boolean;
      processExitedEarly: boolean;
      exitCode?: number | null;
      manifest: BridgeManifest | null;
    }): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const onAbort = (): void => {
      done({ timedOut: false, cancelled: true, processExitedEarly: false, manifest: safeReadManifest() });
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const checkOnce = (): void => {
      const current = safeReadManifest();
      if (current && current.taskId === taskId) {
        if (current.status === 'VERIFIED' || current.status === 'FAILED') {
          done({ timedOut: false, cancelled: false, processExitedEarly: false, manifest: current });
        }
      }
    };

    if (processExitPromise) {
      void processExitPromise.then((exitCode) => {
        if (finished) return;
        checkOnce();
        if (finished) return;
        // Brief grace period for final manifest flush after CLI closes, then fail fast instead of hanging until timeoutSec
        exitGraceTimer = setTimeout(() => {
          checkOnce();
          if (!finished) {
            done({
              timedOut: false,
              cancelled: false,
              processExitedEarly: true,
              exitCode,
              manifest: safeReadManifest(),
            });
          }
        }, 250);
      });
    }

    const bridgeDir = getBridgeDir(workspaceRoot);
    try {
      watcher = fs.watch(bridgeDir, (_eventType, filename) => {
        if (!filename || filename.toString().includes('manifest.json')) {
          checkOnce();
        }
      });
      watcher.on('error', () => {
        // Fall back purely to polling if fs.watch encounters an OS error
      });
    } catch {
      // Fall back to polling
    }

    pollTimer = setInterval(checkOnce, Math.max(100, pollIntervalMs));
    timeoutTimer = setTimeout(() => {
      done({ timedOut: true, cancelled: false, processExitedEarly: false, manifest: safeReadManifest() });
    }, Math.max(1, timeoutSec) * 1000);

    // Immediate check in case status already changed before watch attached
    checkOnce();
  });
}

export class SubscriptionEngine implements ExecutionEngine {
  public readonly mode = 'subscription' as const;
  private readonly triggerFn: TriggerFn;

  constructor(options: SubscriptionEngineOptions = {}) {
    this.triggerFn = options.triggerFn ?? defaultSubscriptionTrigger;
  }

  public async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const warnings: string[] = [];
    const timeoutSec = ctx.timeoutSecOverride ?? ctx.config.subscription.timeout_sec;

    const skipPerm =
      ctx.agyOptions?.dangerouslySkipPermissions ??
      ctx.config.subscription.agy_dangerously_skip_permissions;
    if (skipPerm) {
      warnings.push(
        'Executed with `--dangerously-skip-permissions` (permission_mode=always-proceed). Use Git Guard `rollback_ag_task` if any unintended changes occur.',
      );
    }

    // 1. Sync claude-handoff.md workflow template
    const syncRes = syncHandoffTemplate(ctx.workspaceRoot, ctx.pluginRoot);
    if (syncRes.skippedCustomPaths.length > 0) {
      warnings.push(
        `Preserved custom claude-handoff.md at ${syncRes.skippedCustomPaths.join(', ')} (use --force-template to overwrite).`,
      );
    }

    // 2. Trigger local Antigravity via 3-tier fallback
    safeEmitProgress(ctx, {
      progress: 0,
      message: `Dispatching task ${ctx.manifest.taskId} to Antigravity (${ctx.detection.subscription.cliBinary ?? 'subscription'})...`,
    });
    const triggerOutcome = await this.triggerFn(ctx);
    if (triggerOutcome.warning) {
      warnings.push(triggerOutcome.warning);
    }

    try {
      // 3. Watch .ag-bridge/manifest.json via hybrid fs.watch + polling
      const waitResult = await waitForManifestCompletion(
        ctx.workspaceRoot,
        ctx.manifest.taskId,
        timeoutSec,
        ctx.config.subscription.poll_interval_ms,
        ctx.abortSignal,
        triggerOutcome.processExitPromise,
      );

      const capturedMetrics = triggerOutcome.streamState?.metrics;

      if (waitResult.processExitedEarly) {
        const exitDetail = maskSecrets(
          triggerOutcome.streamState?.errorMessage ??
            `Antigravity CLI exited (code ${waitResult.exitCode ?? 'unknown'}) without finalizing .ag-bridge/manifest.json.`,
        );
        const failedManifest: BridgeManifest = {
          ...(waitResult.manifest ?? ctx.manifest),
          status: 'FAILED',
          metrics: {
            ...(waitResult.manifest?.metrics ?? {}),
            ...(capturedMetrics ?? {}),
          },
          updatedAt: new Date().toISOString(),
          errorCode: 'INTERNAL_ERROR',
          error: exitDetail,
        };
        writeManifest(ctx.workspaceRoot, failedManifest);

        const partialReport =
          readReportMarkdown(ctx.workspaceRoot) ??
          `# Antigravity Task Report\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** FAILED\n- **Reason:** ${exitDetail}\n\n${formatTokenUsageMarkdown(failedManifest.metrics)}`;

        return {
          status: 'FAILED',
          reportMarkdown: partialReport,
          changedFiles: listGitChangedFiles(ctx.workspaceRoot),
          artifacts: listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId),
          metrics: failedManifest.metrics,
          warnings,
          errorCode: 'INTERNAL_ERROR',
          errorMessage: exitDetail,
        };
      }

      if (waitResult.cancelled) {
        triggerOutcome.killProcess?.();
        const cancelledManifest: BridgeManifest = {
          ...(waitResult.manifest ?? ctx.manifest),
          status: 'FAILED',
          metrics: {
            ...(waitResult.manifest?.metrics ?? {}),
            ...(capturedMetrics ?? {}),
          },
          updatedAt: new Date().toISOString(),
          errorCode: 'TASK_CANCELLED',
          error: 'Background subscription task was cancelled by user request.',
        };
        writeManifest(ctx.workspaceRoot, cancelledManifest);

        const cancelReport =
          readReportMarkdown(ctx.workspaceRoot) ??
          `# Antigravity Task Report (Cancelled)\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** CANCELLED\n\n${formatTokenUsageMarkdown(cancelledManifest.metrics)}`;

        return {
          status: 'FAILED',
          reportMarkdown: cancelReport,
          changedFiles: listGitChangedFiles(ctx.workspaceRoot),
          artifacts: listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId),
          metrics: cancelledManifest.metrics,
          warnings,
          errorCode: 'TASK_CANCELLED',
          errorMessage: cancelledManifest.error,
        };
      }

      if (waitResult.timedOut) {
        triggerOutcome.killProcess?.();
        const failedManifest: BridgeManifest = {
          ...(waitResult.manifest ?? ctx.manifest),
          status: 'FAILED',
          metrics: {
            ...(waitResult.manifest?.metrics ?? {}),
            ...(capturedMetrics ?? {}),
          },
          updatedAt: new Date().toISOString(),
          errorCode: 'TASK_TIMEOUT',
          error: `Subscription task timed out after ${timeoutSec}s waiting for .ag-bridge/manifest.json completion.`,
        };
        writeManifest(ctx.workspaceRoot, failedManifest);

        const partialReport =
          readReportMarkdown(ctx.workspaceRoot) ??
          `# Antigravity Task Report\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** FAILED\n- **Reason:** Timed out after ${timeoutSec}s.\n`;

        return {
          status: 'FAILED',
          reportMarkdown: partialReport,
          changedFiles: listGitChangedFiles(ctx.workspaceRoot),
          artifacts: listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId),
          metrics: failedManifest.metrics,
          warnings,
          errorCode: 'TASK_TIMEOUT',
          errorMessage: failedManifest.error,
        };
      }

      const finalManifest = waitResult.manifest ?? ctx.manifest;
      const mergedMetrics: ExecutionMetrics | undefined =
        finalManifest.metrics || (capturedMetrics && Object.keys(capturedMetrics).length > 0)
          ? { ...(finalManifest.metrics ?? {}), ...(capturedMetrics ?? {}) }
          : undefined;

      if (mergedMetrics) {
        writeManifest(ctx.workspaceRoot, {
          ...finalManifest,
          metrics: mergedMetrics,
        });
      }

      const diskArtifacts = listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId);
      const mergedArtifacts = Array.from(
        new Set([...(finalManifest.artifacts ?? []), ...diskArtifacts]),
      ).sort();

      const baselineUntracked = new Set(ctx.manifest.gitUntrackedBaseline ?? []);
      const gitChanged = listGitChangedFiles(ctx.workspaceRoot).filter(
        (f) => !baselineUntracked.has(f) && !f.startsWith('.agent/') && !f.startsWith('.agents/'),
      );
      const mergedChanged = Array.from(
        new Set([...(finalManifest.changedFiles ?? []), ...gitChanged]),
      ).sort();

      const reportMarkdown =
        readReportMarkdown(ctx.workspaceRoot) ??
        `# Antigravity Task Report\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** ${finalManifest.status}\n- **Engine:** subscription\n\n${formatTokenUsageMarkdown(mergedMetrics)}`;

      return {
        status: finalManifest.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED',
        reportMarkdown,
        structuredOutput: triggerOutcome.streamState?.structuredOutput,
        changedFiles: mergedChanged,
        artifacts: mergedArtifacts,
        metrics: mergedMetrics,
        warnings,
        errorCode:
          finalManifest.status === 'FAILED' ? finalManifest.errorCode ?? 'INTERNAL_ERROR' : undefined,
        errorMessage: finalManifest.status === 'FAILED' ? finalManifest.error : undefined,
      };
    } finally {
      triggerOutcome.stopStream?.();
    }
  }
}
