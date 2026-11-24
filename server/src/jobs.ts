import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireBridgeLock,
  clearReportMarkdown,
  ensureBridgeDirs,
  ensureGitignoreEntry,
  generateTaskId,
  getArtifactsDir,
  listTaskArtifacts,
  readAllTaskManifests,
  readArchivedManifest,
  readManifest,
  readReportMarkdown,
  writeDispatchMarkdown,
  writeManifest,
} from './bridge-fs.js';
import { describeIgnoredSettings, loadConfig, maskSecrets } from './config.js';
import {
  assertResolvedMode,
  detectEnvironment,
  DetectorDeps,
  getDefaultDetectorDeps,
} from './detector.js';
import { ApiWorkerEngine } from './engines/api-worker.js';
import { ExecutionEngine, ExecutionResult } from './engines/base.js';
import { SubscriptionEngine } from './engines/subscription.js';
import { checkpointManifestFields, createCheckpoint } from './git-guard.js';
import { validateLockedPathsConfig } from './path-guard.js';
import {
  AgErrorCode,
  AgyCliOptions,
  BackgroundJobState,
  BackgroundJobSummary,
  BridgeManifest,
  CancelJobToolInput,
  CancelJobToolOutput,
  DelegateToolInput,
  GetJobToolInput,
  GetJobToolOutput,
  ResolvedExecutionMode,
  StartJobToolOutput,
} from './types.js';

export interface JobDependencies {
  pluginRoot?: string;
  detectorDeps?: DetectorDeps;
  subscriptionEngine?: ExecutionEngine;
  apiWorkerEngine?: ExecutionEngine;
  jobManager?: BackgroundJobManager;
}

interface LiveJobRecord {
  jobId: string;
  taskId: string;
  title: string;
  mode: ResolvedExecutionMode;
  workspaceRoot: string;
  startedAt: string;
  startedAtMs: number;
  updatedAt: string;
  status: BackgroundJobState;
  active: boolean;
  gitCheckpointRef?: string;
  warnings: string[];
  abortController: AbortController;
  result?: ExecutionResult;
  errorCode?: AgErrorCode;
  errorMessage?: string;
  completionPromise: Promise<void>;
}

function readLogTail(workspaceRoot: string, taskId: string, maxLines = 30): string | undefined {
  const logPath = path.join(getArtifactsDir(workspaceRoot, taskId), 'agy-cli.log');
  try {
    if (!fs.existsSync(logPath)) return undefined;
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return undefined;
    return maskSecrets(lines.slice(-maxLines).join('\n'));
  } catch {
    return undefined;
  }
}

function extractAgyOptions(input: DelegateToolInput): AgyCliOptions {
  return {
    model: input.model,
    effort: input.effort,
    agent: input.agent,
    agyMode: input.agyMode,
    sandbox: input.sandbox,
    dangerouslySkipPermissions: input.dangerouslySkipPermissions,
    addDirs: input.addDirs,
    continueConversation: input.continueConversation,
    conversationId: input.conversationId,
    project: input.project,
    newProject: input.newProject,
    remoteAgent: input.remoteAgent,
    jsonSchema: input.jsonSchema,
    disableSlashCommands: input.disableSlashCommands,
    settings: input.settings,
    rawPrompt: input.rawPrompt,
  };
}

export class BackgroundJobManager {
  private readonly jobs = new Map<string, LiveJobRecord>();

  public register(record: LiveJobRecord): void {
    this.jobs.set(record.jobId, record);
  }

  public get(jobId: string): LiveJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  public getLatestActive(workspaceRoot?: string): LiveJobRecord | undefined {
    let latest: LiveJobRecord | undefined;
    for (const j of this.jobs.values()) {
      if (!j.active) continue;
      if (workspaceRoot && path.resolve(j.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
      if (!latest || j.startedAtMs > latest.startedAtMs) {
        latest = j;
      }
    }
    return latest;
  }

  public listRecords(workspaceRoot?: string): LiveJobRecord[] {
    const out: LiveJobRecord[] = [];
    for (const j of this.jobs.values()) {
      if (workspaceRoot && path.resolve(j.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
      out.push(j);
    }
    return out.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  public activeCount(workspaceRoot?: string): number {
    let count = 0;
    for (const j of this.jobs.values()) {
      if (!j.active) continue;
      if (workspaceRoot && path.resolve(j.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
      count += 1;
    }
    return count;
  }

  public disposeAll(): void {
    for (const j of this.jobs.values()) {
      if (j.active) {
        try {
          j.abortController.abort();
        } catch {
          // ignore
        }
      }
    }
    this.jobs.clear();
  }
}

export const defaultJobManager = new BackgroundJobManager();

export function disposeActiveJobs(): void {
  defaultJobManager.disposeAll();
}

function summarizeLiveJob(
  rec: LiveJobRecord,
  includeDetails: boolean,
  includeLogTail: boolean,
): BackgroundJobSummary {
  const diskManifest = readManifest(rec.workspaceRoot);
  const matchingDisk =
    diskManifest?.taskId === rec.taskId
      ? diskManifest
      : readArchivedManifest(rec.workspaceRoot, rec.taskId);

  const metrics = rec.result?.metrics ?? matchingDisk?.metrics;
  const elapsedSeconds =
    metrics?.durationSeconds ??
    Math.round(((Date.now() - rec.startedAtMs) / 1000) * 100) / 100;

  return {
    jobId: rec.jobId,
    taskId: rec.taskId,
    title: rec.title,
    mode: rec.mode,
    status: rec.status,
    active: rec.active,
    startedAt: rec.startedAt,
    updatedAt: matchingDisk?.updatedAt ?? rec.updatedAt,
    elapsedSeconds,
    gitCheckpointRef: rec.gitCheckpointRef,
    conversationId: metrics?.conversationId,
    model: metrics?.model,
    metrics,
    changedFiles: includeDetails ? rec.result?.changedFiles ?? matchingDisk?.changedFiles : undefined,
    artifacts: includeDetails
      ? rec.result?.artifacts ?? listTaskArtifacts(rec.workspaceRoot, rec.taskId)
      : undefined,
    reportMarkdown: includeDetails
      ? rec.result?.reportMarkdown
        ? maskSecrets(rec.result.reportMarkdown)
        : diskManifest?.taskId === rec.taskId
          ? (() => {
              const r = readReportMarkdown(rec.workspaceRoot);
              return r ? maskSecrets(r) : undefined;
            })()
          : undefined
      : undefined,
    structuredOutput: includeDetails ? rec.result?.structuredOutput : undefined,
    logTail: includeLogTail ? readLogTail(rec.workspaceRoot, rec.taskId) : undefined,
    warnings: [...rec.warnings, ...(rec.result?.warnings ?? [])],
    errorCode: rec.errorCode ?? rec.result?.errorCode,
    errorMessage: rec.errorMessage ?? rec.result?.errorMessage,
  };
}

function summarizeDiskManifest(
  workspaceRoot: string,
  m: BridgeManifest,
  includeDetails: boolean,
  includeLogTail: boolean,
): BackgroundJobSummary {
  const createdMs = Date.parse(m.createdAt);
  const updatedMs = Date.parse(m.updatedAt);
  const elapsedSeconds =
    m.metrics?.durationSeconds ??
    (Number.isFinite(createdMs) && Number.isFinite(updatedMs)
      ? Math.max(0, Math.round(((updatedMs - createdMs) / 1000) * 100) / 100)
      : 0);

  let status: BackgroundJobState = 'RUNNING';
  if (m.status === 'VERIFIED') status = 'VERIFIED';
  else if (m.errorCode === 'TASK_CANCELLED') status = 'CANCELLED';
  else if (m.status === 'FAILED') status = 'FAILED';

  const currentManifest = readManifest(workspaceRoot);
  const isCurrent = currentManifest?.taskId === m.taskId;

  return {
    jobId: m.taskId,
    taskId: m.taskId,
    title: m.title,
    mode: m.mode,
    status,
    active: status === 'RUNNING',
    startedAt: m.createdAt,
    updatedAt: m.updatedAt,
    elapsedSeconds,
    gitCheckpointRef: m.gitCheckpointRef,
    conversationId: m.metrics?.conversationId,
    model: m.metrics?.model,
    metrics: m.metrics,
    changedFiles: includeDetails ? m.changedFiles : undefined,
    artifacts: includeDetails ? listTaskArtifacts(workspaceRoot, m.taskId) : undefined,
    reportMarkdown:
      includeDetails && isCurrent
        ? (() => {
            const r = readReportMarkdown(workspaceRoot);
            return r ? maskSecrets(r) : undefined;
          })()
        : undefined,
    logTail: includeLogTail ? readLogTail(workspaceRoot, m.taskId) : undefined,
    warnings: [],
    errorCode: m.errorCode,
    errorMessage: m.error,
  };
}

export async function handleStartAgTask(
  input: DelegateToolInput,
  deps: JobDependencies = {},
): Promise<StartJobToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const pluginRoot =
    deps.pluginRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manager = deps.jobManager ?? defaultJobManager;
  const warnings: string[] = [];

  // Fail-closed security check FIRST before provider detection
  let normalizedLockedPaths: string[] = [];
  if (input.lockedPaths && input.lockedPaths.length > 0) {
    normalizedLockedPaths = validateLockedPathsConfig(workspaceRoot, input.lockedPaths);
  }

  const config = loadConfig(workspaceRoot, deps.detectorDeps?.env ?? process.env);
  const ignoredAdvice = describeIgnoredSettings(config);
  if (ignoredAdvice) {
    warnings.push(ignoredAdvice);
  }
  const detection = detectEnvironment(
    config,
    input.modeOverride,
    deps.detectorDeps ?? getDefaultDetectorDeps(),
  );
  const resolvedMode = assertResolvedMode(detection);

  if (normalizedLockedPaths.length === 0 && resolvedMode === 'api') {
    warnings.push(
      'No lockedPaths provided in API mode: read-only analysis is allowed, while write_file remains fail-closed.',
    );
  }

  ensureBridgeDirs(workspaceRoot);
  ensureGitignoreEntry(workspaceRoot);

  const effectiveTimeoutSec = input.timeoutSec ?? config.subscription.timeout_sec;
  const lockRes = acquireBridgeLock(workspaceRoot, effectiveTimeoutSec);
  warnings.push(...lockRes.warnings);

  const taskId = generateTaskId();
  const checkpoint = createCheckpoint(workspaceRoot, taskId, config.git_guard);
  if (checkpoint.warning) {
    warnings.push(checkpoint.warning);
  }

  const now = new Date().toISOString();
  const acceptanceCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : ['Complete the delegated instructions and report verified results clearly.'];

  const manifest: BridgeManifest = {
    schemaVersion: 1,
    taskId,
    title: input.title,
    mode: resolvedMode,
    status: 'DISPATCHED',
    lockedPaths: normalizedLockedPaths,
    verifyUrl: input.verifyUrl,
    createdAt: now,
    updatedAt: now,
    ...checkpointManifestFields(checkpoint),
    artifacts: [],
  };

  writeManifest(workspaceRoot, manifest);
  clearReportMarkdown(workspaceRoot);
  writeDispatchMarkdown(workspaceRoot, {
    manifest,
    instructions: input.instructions,
    acceptanceCriteria,
  });

  const engine: ExecutionEngine =
    resolvedMode === 'subscription'
      ? (deps.subscriptionEngine ?? new SubscriptionEngine())
      : (deps.apiWorkerEngine ?? new ApiWorkerEngine());

  const abortController = new AbortController();
  const record: LiveJobRecord = {
    jobId: taskId,
    taskId,
    title: input.title,
    mode: resolvedMode,
    workspaceRoot,
    startedAt: now,
    startedAtMs: Date.now(),
    updatedAt: now,
    status: 'RUNNING',
    active: true,
    gitCheckpointRef: checkpoint.checkpointRef,
    warnings: [...warnings],
    abortController,
    completionPromise: Promise.resolve(),
  };

  record.completionPromise = engine
    .execute({
      workspaceRoot,
      pluginRoot,
      manifest,
      config,
      instructions: input.instructions,
      acceptanceCriteria,
      detection,
      agyOptions: extractAgyOptions(input),
      timeoutSecOverride: input.timeoutSec,
      abortSignal: abortController.signal,
    })
    .then((execRes) => {
      record.result = execRes;
      record.active = false;
      record.updatedAt = new Date().toISOString();
      if (execRes.errorCode === 'TASK_CANCELLED' || abortController.signal.aborted) {
        record.status = 'CANCELLED';
        record.errorCode = 'TASK_CANCELLED';
        record.errorMessage = execRes.errorMessage ?? 'Task was cancelled.';
      } else if (execRes.status === 'VERIFIED') {
        record.status = 'VERIFIED';
      } else {
        record.status = 'FAILED';
        record.errorCode = execRes.errorCode;
        record.errorMessage = execRes.errorMessage ? maskSecrets(execRes.errorMessage) : undefined;
      }
    })
    .catch((err) => {
      record.active = false;
      record.updatedAt = new Date().toISOString();
      record.status = abortController.signal.aborted ? 'CANCELLED' : 'FAILED';
      record.errorCode = abortController.signal.aborted ? 'TASK_CANCELLED' : 'INTERNAL_ERROR';
      record.errorMessage = maskSecrets(err instanceof Error ? err.message : String(err));
      try {
        const cur = readManifest(workspaceRoot);
        if (cur && cur.taskId === taskId && (cur.status === 'DISPATCHED' || cur.status === 'RUNNING')) {
          writeManifest(workspaceRoot, {
            ...cur,
            status: 'FAILED',
            errorCode: record.errorCode,
            error: record.errorMessage,
            updatedAt: record.updatedAt,
          });
        }
      } catch {
        // ignore
      }
    });

  manager.register(record);

  return {
    ok: true,
    jobId: taskId,
    taskId,
    mode: resolvedMode,
    status: 'RUNNING',
    gitCheckpointRef: checkpoint.checkpointRef,
    warnings,
    nextSteps: [
      `Continue other work in parallel while Antigravity executes \`${taskId}\`.`,
      `Check live progress or collect results: \`/ag-jobs ${taskId}\` (or \`get_ag_job({ jobId: "${taskId}" })\`).`,
      `Cancel if needed: \`/ag-cancel ${taskId}\` (or \`cancel_ag_job({ jobId: "${taskId}" })\`).`,
    ],
  };
}

export async function handleGetAgJob(
  input: GetJobToolInput = {},
  deps: JobDependencies = {},
): Promise<GetJobToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const manager = deps.jobManager ?? defaultJobManager;
  const includeLogTail = input.includeLogTail ?? true;

  if (input.jobId) {
    const live = manager.get(input.jobId);
    if (live) {
      return {
        ok: true,
        job: summarizeLiveJob(live, true, includeLogTail),
        activeCount: manager.activeCount(workspaceRoot),
      };
    }

    const current = readManifest(workspaceRoot);
    const disk =
      current?.taskId === input.jobId
        ? current
        : readArchivedManifest(workspaceRoot, input.jobId);
    if (!disk) {
      return {
        ok: false,
        activeCount: manager.activeCount(workspaceRoot),
        errorCode: 'JOB_NOT_FOUND',
        errorMessage: `No background job or archived task found for jobId "${input.jobId}".`,
      };
    }

    return {
      ok: true,
      job: summarizeDiskManifest(workspaceRoot, disk, true, includeLogTail),
      activeCount: manager.activeCount(workspaceRoot),
    };
  }

  // List mode: merge live in-memory jobs + recent disk manifests (deduped by taskId)
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const seen = new Set<string>();
  const summaries: BackgroundJobSummary[] = [];

  for (const live of manager.listRecords(workspaceRoot)) {
    seen.add(live.taskId);
    summaries.push(summarizeLiveJob(live, false, false));
  }

  for (const m of readAllTaskManifests(workspaceRoot)) {
    if (seen.has(m.taskId)) continue;
    seen.add(m.taskId);
    summaries.push(summarizeDiskManifest(workspaceRoot, m, false, false));
    if (summaries.length >= limit) break;
  }

  return {
    ok: true,
    jobs: summaries.slice(0, limit),
    activeCount: manager.activeCount(workspaceRoot),
  };
}

export async function handleCancelAgJob(
  input: CancelJobToolInput = {},
  deps: JobDependencies = {},
): Promise<CancelJobToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const manager = deps.jobManager ?? defaultJobManager;

  const target = input.jobId
    ? manager.get(input.jobId)
    : manager.getLatestActive(workspaceRoot);

  if (!target || !target.active) {
    return {
      ok: true,
      jobId: input.jobId,
      status: 'NOT_RUNNING',
      message: input.jobId
        ? `Job "${input.jobId}" is not currently running.`
        : 'No active background Antigravity job is currently running.',
      nextSteps: ['Run `/ag-jobs` to inspect recent jobs or `/ag-start` to launch a new one.'],
    };
  }

  target.abortController.abort();
  target.active = false;
  target.status = 'CANCELLED';
  target.errorCode = 'TASK_CANCELLED';
  target.errorMessage = 'Cancelled by user request.';
  target.updatedAt = new Date().toISOString();

  // Wait briefly (up to 1.5s) for graceful cleanup without hanging
  await Promise.race([
    target.completionPromise.catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  try {
    const cur = readManifest(target.workspaceRoot);
    if (cur && cur.taskId === target.taskId && (cur.status === 'DISPATCHED' || cur.status === 'RUNNING')) {
      writeManifest(target.workspaceRoot, {
        ...cur,
        status: 'FAILED',
        errorCode: 'TASK_CANCELLED',
        error: 'Background job was cancelled by user request.',
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    jobId: target.jobId,
    status: 'CANCELLED',
    gitCheckpointRef: target.gitCheckpointRef,
    message: `Cancelled running Antigravity job \`${target.jobId}\` (${target.title}).`,
    nextSteps: target.gitCheckpointRef
      ? [
          `If partial edits were written before cancellation, run \`/ag-rollback ${target.jobId}\` (checkpoint \`${target.gitCheckpointRef}\`) to restore your workspace cleanly.`,
        ]
      : ['Check `git status` to review any partial changes made before cancellation.'],
  };
}
