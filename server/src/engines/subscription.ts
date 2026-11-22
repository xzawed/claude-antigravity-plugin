import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  getArtifactsDir,
  getBridgeDir,
  listTaskArtifacts,
  readManifest,
  readReportMarkdown,
  syncHandoffTemplate,
  writeManifest,
} from '../bridge-fs.js';
import { maskSecrets } from '../config.js';
import { listGitChangedFiles } from '../git-guard.js';
import { BridgeManifest } from '../types.js';
import { ExecutionContext, ExecutionEngine, ExecutionResult } from './base.js';

export interface TriggerOutcome {
  methodUsed: 'cli' | 'ipc' | 'clipboard' | 'custom';
  warning?: string;
}

export type TriggerFn = (ctx: ExecutionContext) => Promise<TriggerOutcome>;

export interface SubscriptionEngineOptions {
  triggerFn?: TriggerFn;
}

function buildHandoffPrompt(taskId: string): string {
  return `/claude-handoff Execute delegated task ${taskId} from .ag-bridge/dispatch.md and update .ag-bridge/manifest.json and .ag-bridge/report.md when done.`;
}

function tryCopyToClipboard(text: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'darwin') {
      execFileSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
      return true;
    }
    if (platform === 'win32') {
      execFileSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
      return true;
    }
    try {
      execFileSync('xclip', ['-selection', 'clipboard'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 3000,
      });
      return true;
    } catch {
      execFileSync('wl-copy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
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
        'osascript',
        ['-e', `display notification "${escapedMsg}" with title "${escapedTitle}"`],
        { stdio: 'ignore', timeout: 3000 },
      );
    } else if (platform === 'linux') {
      execFileSync('notify-send', [title, message], { stdio: 'ignore', timeout: 3000 });
    }
  } catch {
    // Best-effort notification only
  }
}

export interface StreamHeartbeatOptions {
  workspaceRoot: string;
  taskId: string;
  logFilePath?: string;
  minHeartbeatIntervalMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

export function attachStreamJsonHeartbeat(
  stream: Readable,
  options: StreamHeartbeatOptions,
): { stop: () => void } {
  const minInterval = options.minHeartbeatIntervalMs ?? 2000;
  let buffer = '';
  let lastBeatMs = 0;
  let stopped = false;

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
        updatedAt: new Date(nowMs).toISOString(),
      });
    } catch {
      // ignore transient manifest lock errors
    }
  };

  const processLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    appendLog(trimmed);

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options.onEvent?.(parsed as Record<string, unknown>);
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
  const prompt = buildHandoffPrompt(ctx.manifest.taskId);

  if (cliBinary === 'agy') {
    const args = [
      '--print',
      prompt,
      '--mode',
      ctx.config.subscription.agy_mode,
      '--print-timeout',
      `${ctx.config.subscription.timeout_sec}s`,
    ];
    if (ctx.config.subscription.agy_sandbox) {
      args.push('--sandbox');
    }
    if (ctx.config.subscription.agy_stream_heartbeat) {
      args.push('--output-format', 'stream-json');
    }
    return args;
  }

  return ['run', '--workflow', 'claude-handoff'];
}

function quoteForWindowsCmd(arg: string): string {
  // Neutralize cmd.exe metacharacters inside double-quoted argument
  const escaped = arg.replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${escaped}"`;
}

export function buildCliSpawnSpec(
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsHide: boolean; windowsVerbatimArguments?: boolean } {
  // Node.js 20.12+/24 on Windows throws EINVAL when spawning .cmd/.bat with shell: false.
  // Wrapping the full command line in outer quotes for `cmd.exe /d /s /c` with
  // windowsVerbatimArguments preserves paths containing spaces (e.g. "C:\Program Files\...")
  // as well as multi-word arguments.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const innerCmd = [quoteForWindowsCmd(cliPath), ...args.map(quoteForWindowsCmd)].join(' ');
    return {
      command: 'cmd.exe',
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

async function tryCliTrigger(ctx: ExecutionContext): Promise<boolean> {
  const { cliBinary, cliPath } = ctx.detection.subscription;
  if (!cliPath) {
    return false;
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

  return new Promise<boolean>((resolve) => {
    let settled = false;
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
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: ctx.workspaceRoot,
        stdio: useStreamHeartbeat
          ? ['ignore', 'pipe', 'pipe']
          : logFd !== null
            ? ['ignore', logFd, logFd]
            : 'ignore',
        detached: !useStreamHeartbeat,
        shell: false,
        windowsHide: spawnSpec.windowsHide,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      });

      // Child inherited logFd; close parent descriptor immediately
      closeLogFd();

      let heartbeatHandle: { stop: () => void } | null = null;
      if (useStreamHeartbeat && child.stdout) {
        heartbeatHandle = attachStreamJsonHeartbeat(child.stdout, {
          workspaceRoot: ctx.workspaceRoot,
          taskId: ctx.manifest.taskId,
          logFilePath,
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

      child.once('error', () => {
        heartbeatHandle?.stop();
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });

      child.once('exit', (code) => {
        heartbeatHandle?.stop();
        if (!settled) {
          settled = true;
          resolve(code === 0);
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
          resolve(true);
        }
      }, 400).unref();
    } catch {
      closeLogFd();
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }
  });
}

function tryOsIpcTrigger(ctx: ExecutionContext): boolean {
  const platform = ctx.detection.platform;
  const prompt = buildHandoffPrompt(ctx.manifest.taskId);
  try {
    if (platform === 'darwin') {
      tryCopyToClipboard(prompt, platform);
      execFileSync('osascript', ['-e', 'tell application "Antigravity" to activate'], {
        stdio: 'ignore',
        timeout: 3000,
      });
      return true;
    }
    if (platform === 'win32') {
      tryCopyToClipboard(prompt, platform);
      execFileSync(
        'powershell',
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
  const method = ctx.config.subscription.trigger_method;
  const prompt = buildHandoffPrompt(ctx.manifest.taskId);

  if (method === 'cli_only' || method === 'cli_or_ipc') {
    const cliOk = await tryCliTrigger(ctx);
    if (cliOk) {
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
): Promise<{ timedOut: boolean; manifest: BridgeManifest | null }> {
  return new Promise((resolve) => {
    let finished = false;
    let watcher: fs.FSWatcher | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
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
    };

    const done = (result: { timedOut: boolean; manifest: BridgeManifest | null }): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const checkOnce = (): void => {
      try {
        const current = readManifest(workspaceRoot);
        if (current && current.taskId === taskId) {
          if (current.status === 'VERIFIED' || current.status === 'FAILED') {
            done({ timedOut: false, manifest: current });
          }
        }
      } catch {
        // Ignore transient read errors during concurrent writes
      }
    };

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
      done({ timedOut: true, manifest: readManifest(workspaceRoot) });
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

    // 1. Sync claude-handoff.md workflow template
    const syncRes = syncHandoffTemplate(ctx.workspaceRoot, ctx.pluginRoot);
    if (syncRes.skippedCustomPaths.length > 0) {
      warnings.push(
        `Preserved custom claude-handoff.md at ${syncRes.skippedCustomPaths.join(', ')} (use --force-template to overwrite).`,
      );
    }

    // 2. Trigger local Antigravity via 3-tier fallback
    const triggerOutcome = await this.triggerFn(ctx);
    if (triggerOutcome.warning) {
      warnings.push(triggerOutcome.warning);
    }

    // 3. Watch .ag-bridge/manifest.json via hybrid fs.watch + polling
    const waitResult = await waitForManifestCompletion(
      ctx.workspaceRoot,
      ctx.manifest.taskId,
      ctx.config.subscription.timeout_sec,
      ctx.config.subscription.poll_interval_ms,
    );

    if (waitResult.timedOut) {
      const failedManifest: BridgeManifest = {
        ...(waitResult.manifest ?? ctx.manifest),
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        errorCode: 'TASK_TIMEOUT',
        error: `Subscription task timed out after ${ctx.config.subscription.timeout_sec}s waiting for .ag-bridge/manifest.json completion.`,
      };
      writeManifest(ctx.workspaceRoot, failedManifest);

      const partialReport =
        readReportMarkdown(ctx.workspaceRoot) ??
        `# Antigravity Task Report\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** FAILED\n- **Reason:** Timed out after ${ctx.config.subscription.timeout_sec}s.\n`;

      return {
        status: 'FAILED',
        reportMarkdown: partialReport,
        changedFiles: listGitChangedFiles(ctx.workspaceRoot),
        artifacts: listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId),
        warnings,
        errorCode: 'TASK_TIMEOUT',
        errorMessage: failedManifest.error,
      };
    }

    const finalManifest = waitResult.manifest ?? ctx.manifest;
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
      `# Antigravity Task Report\n\n- **Task ID:** \`${ctx.manifest.taskId}\`\n- **Status:** ${finalManifest.status}\n- **Engine:** subscription\n\n(No report.md was written by the worker.)\n`;

    return {
      status: finalManifest.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED',
      reportMarkdown,
      changedFiles: mergedChanged,
      artifacts: mergedArtifacts,
      warnings,
      errorCode: finalManifest.status === 'FAILED' ? finalManifest.errorCode ?? 'INTERNAL_ERROR' : undefined,
      errorMessage: finalManifest.status === 'FAILED' ? finalManifest.error : undefined,
    };
  }
}
