import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleListArtifacts } from './artifacts.js';
import { AuthDependencies, disposePendingAuthSessions, handleAgAuth } from './auth.js';
import { CliAdminDependencies, handleAgCliAdmin } from './cli-admin.js';
import {
  defaultJobManager,
  disposeActiveJobs,
  handleCancelAgJob,
  handleGetAgJob,
  handleStartAgTask,
  JobDependencies,
} from './jobs.js';
import {
  disposePersistentSessions,
  handleAgSession,
  SessionDependencies,
} from './sessions.js';
import {
  acquireBridgeLock,
  archiveManifest,
  assertSafeTaskId,
  clearReportMarkdown,
  ensureBridgeDirs,
  ensureGitignoreEntry,
  generateTaskId,
  getBridgeDir,
  isGitignoreProtected,
  readAllTaskManifests,
  readArchivedManifest,
  readManifest,
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
import { ExecutionEngine, ProgressCallback } from './engines/base.js';
import { AgyCapabilityQuery, queryAgyCapabilities, SubscriptionEngine } from './engines/subscription.js';
import {
  checkpointManifestFields,
  createCheckpoint,
  createTaskWorktree,
  getGitInfo,
  removeTaskWorktree,
  resolveSafeWorktreeRoot,
  rollbackCheckpoint,
  WORKTREE_BRANCH_PREFIX,
} from './git-guard.js';
import { validateLockedPathsConfig } from './path-guard.js';
import {
  AgPluginError,
  AgyCliOptions,
  BridgeManifest,
  CheckEnvironmentOutput,
  DelegateToolInput,
  DelegateToolOutput,
  ListCapabilitiesOutput,
  RollbackToolInput,
  RollbackToolOutput,
  TaskUsageRecord,
  TokenUsage,
  UsageSummaryOutput,
} from './types.js';

export interface ServerDependencies {
  pluginRoot?: string;
  detectorDeps?: DetectorDeps;
  subscriptionEngine?: ExecutionEngine;
  apiWorkerEngine?: ExecutionEngine;
  queryCapabilitiesFn?: (
    cliPath: string,
    platform?: NodeJS.Platform,
    query?: AgyCapabilityQuery,
  ) =>
    | Awaited<ReturnType<typeof queryAgyCapabilities>>
    | ReturnType<typeof queryAgyCapabilities>;
  authDeps?: AuthDependencies;
  jobDeps?: JobDependencies;
  sessionDeps?: SessionDependencies;
  cliAdminDeps?: CliAdminDependencies;
}

function getDefaultPluginRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..', '..');
}

function toJsonToolResponse(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.thinkingTokens += delta.thinkingTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.totalTokens += delta.totalTokens;
}

export async function handleCheckEnvironment(
  workspaceRootInput: string | undefined,
  deps: ServerDependencies = {},
): Promise<CheckEnvironmentOutput> {
  const workspaceRoot = path.resolve(workspaceRootInput ?? process.cwd());
  const config = loadConfig(workspaceRoot, deps.detectorDeps?.env ?? process.env);
  const detection = detectEnvironment(config, undefined, deps.detectorDeps ?? getDefaultDetectorDeps());
  const git = getGitInfo(workspaceRoot);
  const manifest = readManifest(workspaceRoot);

  return {
    ...detection,
    git,
    agyConfig: {
      mode: config.subscription.agy_mode,
      sandbox: config.subscription.agy_sandbox,
      dangerouslySkipPermissions: config.subscription.agy_dangerously_skip_permissions,
      streamHeartbeat: config.subscription.agy_stream_heartbeat,
      model: config.subscription.agy_model,
      effort: config.subscription.agy_effort,
      agent: config.subscription.agy_agent,
    },
    bridge: {
      initialized: fs.existsSync(getBridgeDir(workspaceRoot)),
      gitignoreProtected: isGitignoreProtected(workspaceRoot),
      currentStatus: manifest?.status ?? 'IDLE',
      lastTaskId: manifest?.taskId,
      lastUpdatedAt: manifest?.updatedAt,
      lastConversationId: manifest?.metrics?.conversationId,
      lastUsage: manifest?.metrics?.usage,
    },
  };
}

export async function handleListCapabilities(
  workspaceRootInput: string | undefined,
  deps: ServerDependencies = {},
): Promise<ListCapabilitiesOutput> {
  const workspaceRoot = path.resolve(workspaceRootInput ?? process.cwd());
  const detDeps = deps.detectorDeps ?? getDefaultDetectorDeps();
  const config = loadConfig(workspaceRoot, detDeps.env);
  const detection = detectEnvironment(config, undefined, detDeps);
  const warnings: string[] = [];

  let models: ListCapabilitiesOutput['models'] = [];
  let agents: string[] = [];

  if (detection.subscription.detected && detection.subscription.cliBinary === 'agy' && detection.subscription.cliPath) {
    const queryFn = deps.queryCapabilitiesFn ?? queryAgyCapabilities;
    // In the workspace, so agy also names the agents it defines; probe when `agy agents` is silent.
    const cap = await queryFn(detection.subscription.cliPath, detection.platform, {
      cwd: workspaceRoot,
      probeAgents: true,
    });
    models = cap.models;
    agents = cap.agents;
    warnings.push(...cap.warnings);
  } else {
    warnings.push(
      'Local `agy` CLI was not detected; live model/agent discovery requires Antigravity CLI (`agy`).',
    );
  }

  return {
    subscriptionDetected: detection.subscription.detected,
    cliBinary: detection.subscription.cliBinary,
    cliPath: detection.subscription.cliPath,
    models,
    agents,
    supportedPermissionModes: [
      'accept-edits',
      'auto',
      'plan',
      '--dangerously-skip-permissions (always-proceed)',
    ],
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportedFlags: [
      '--print',
      '--mode',
      '--dangerously-skip-permissions',
      '--sandbox',
      '--model',
      '--effort',
      '--agent',
      '--add-dir',
      '--continue',
      '--conversation',
      '--project',
      '--new-project',
      '--remote-agent',
      '--json-schema',
      '--disable-slash-commands',
      '--settings',
      '--print-timeout',
      '--output-format stream-json',
    ],
    currentDefaults: {
      agyMode: config.subscription.agy_mode,
      sandbox: config.subscription.agy_sandbox,
      dangerouslySkipPermissions: config.subscription.agy_dangerously_skip_permissions,
      streamHeartbeat: config.subscription.agy_stream_heartbeat,
      model: config.subscription.agy_model,
      effort: config.subscription.agy_effort,
      agent: config.subscription.agy_agent,
    },
    warnings,
  };
}

export async function handleGetUsage(
  workspaceRootInput: string | undefined,
  limit = 20,
): Promise<UsageSummaryOutput> {
  const workspaceRoot = path.resolve(workspaceRootInput ?? process.cwd());
  const manifests = readAllTaskManifests(workspaceRoot);

  const totals = emptyUsage();
  const subUsage = emptyUsage();
  const apiUsage = emptyUsage();
  let subTasks = 0;
  let apiTasks = 0;
  let tasksWithUsage = 0;
  let totalDurationSeconds = 0;
  const recentTasks: TaskUsageRecord[] = [];

  for (const m of manifests) {
    if (m.mode === 'subscription') subTasks += 1;
    else apiTasks += 1;

    if (typeof m.metrics?.durationSeconds === 'number') {
      totalDurationSeconds += m.metrics.durationSeconds;
    }

    const u = m.metrics?.usage;
    if (u) {
      tasksWithUsage += 1;
      addUsage(totals, u);
      if (m.mode === 'subscription') addUsage(subUsage, u);
      else addUsage(apiUsage, u);
    }

    if (recentTasks.length < Math.max(1, limit)) {
      recentTasks.push({
        taskId: m.taskId,
        title: m.title,
        mode: m.mode,
        status: m.status,
        model: m.metrics?.model,
        conversationId: m.metrics?.conversationId,
        durationSeconds: m.metrics?.durationSeconds,
        numTurns: m.metrics?.numTurns,
        usage: u ?? emptyUsage(),
        updatedAt: m.updatedAt,
      });
    }
  }

  return {
    totalTasks: manifests.length,
    tasksWithUsage,
    totals,
    totalDurationSeconds: Math.round(totalDurationSeconds * 100) / 100,
    byMode: {
      subscription: { tasks: subTasks, usage: subUsage },
      api: { tasks: apiTasks, usage: apiUsage },
    },
    recentTasks,
  };
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

export interface DelegateRuntimeOptions {
  onProgress?: ProgressCallback;
  abortSignal?: AbortSignal;
}

export async function handleDelegateToAntigravity(
  input: DelegateToolInput,
  deps: ServerDependencies = {},
  runtimeOptions?: DelegateRuntimeOptions,
): Promise<DelegateToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const pluginRoot = deps.pluginRoot ?? getDefaultPluginRoot();
  const warnings: string[] = [];

  // Fail-closed security check FIRST: validate lockedPaths whenever provided,
  // regardless of provider availability.
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
    // API worker stays fail-closed on file writes when lockedPaths is omitted
    warnings.push(
      'No lockedPaths provided in API mode: read-only analysis is allowed, while write_file remains fail-closed.',
    );
  }

  ensureBridgeDirs(workspaceRoot);
  ensureGitignoreEntry(workspaceRoot);

  const effectiveTimeoutSec = input.timeoutSec ?? config.subscription.timeout_sec;
  const taskId = generateTaskId();

  let executionRoot = workspaceRoot;
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;

  if (input.isolateWorktree) {
    const wt = createTaskWorktree(workspaceRoot, taskId);
    executionRoot = wt.worktreePath;
    worktreePath = wt.worktreePath;
    worktreeBranch = wt.branchName;
    if (wt.warning) {
      warnings.push(wt.warning);
    }
  }

  let checkpoint: ReturnType<typeof createCheckpoint>;
  let manifest: BridgeManifest;
  const acceptanceCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : ['Complete the delegated instructions and report verified results clearly.'];

  let lockRelease: (() => void) | undefined;
  try {
    if (worktreePath) {
      if (normalizedLockedPaths.length > 0) {
        normalizedLockedPaths = validateLockedPathsConfig(executionRoot, normalizedLockedPaths);
      }
      ensureBridgeDirs(executionRoot);
      ensureGitignoreEntry(executionRoot);
    }

    const lockRes = acquireBridgeLock(executionRoot, effectiveTimeoutSec);
    lockRelease = lockRes.release;
    warnings.push(...lockRes.warnings);

    checkpoint = createCheckpoint(executionRoot, taskId, config.git_guard);
    if (checkpoint.warning) {
      warnings.push(checkpoint.warning);
    }

    const now = new Date().toISOString();
    manifest = {
      schemaVersion: 1,
      taskId,
      title: input.title,
      mode: resolvedMode,
      status: 'DISPATCHED',
      timeoutSec: effectiveTimeoutSec,
      lockedPaths: normalizedLockedPaths,
      verifyUrl: input.verifyUrl,
      createdAt: now,
      updatedAt: now,
      ...checkpointManifestFields(checkpoint),
      ...(worktreePath ? { worktreePath } : {}),
      ...(worktreeBranch ? { worktreeBranch } : {}),
      artifacts: [],
    };

    writeManifest(executionRoot, manifest);
    if (worktreePath) {
      archiveManifest(workspaceRoot, manifest);
    }
    clearReportMarkdown(executionRoot);
    writeDispatchMarkdown(executionRoot, {
      manifest,
      instructions: input.instructions,
      acceptanceCriteria,
    });
  } catch (err) {
    if (worktreePath) {
      try {
        removeTaskWorktree(workspaceRoot, worktreePath, worktreeBranch, true);
      } catch {
        // Best-effort cleanup of newly created worktree on setup failure
      }
    }
    throw err;
  } finally {
    lockRelease?.();
  }

  const engine: ExecutionEngine =
    resolvedMode === 'subscription'
      ? (deps.subscriptionEngine ?? new SubscriptionEngine())
      : (deps.apiWorkerEngine ?? new ApiWorkerEngine());

  let execRes: Awaited<ReturnType<ExecutionEngine['execute']>>;
  try {
    execRes = await engine.execute({
      workspaceRoot: executionRoot,
      pluginRoot,
      manifest,
      config,
      instructions: input.instructions,
      acceptanceCriteria,
      detection,
      agyOptions: extractAgyOptions(input),
      timeoutSecOverride: input.timeoutSec,
      abortSignal: runtimeOptions?.abortSignal,
      onProgress: runtimeOptions?.onProgress,
    });
  } catch (err) {
    const errMsg = maskSecrets(err instanceof Error ? err.message : String(err));
    const errCode = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
    const failedAt = new Date().toISOString();
    try {
      const disk = readManifest(executionRoot);
      const updated: BridgeManifest = {
        ...(disk ?? manifest),
        status: 'FAILED',
        errorCode: errCode,
        error: errMsg,
        updatedAt: failedAt,
      };
      writeManifest(executionRoot, updated);
      if (worktreePath) {
        archiveManifest(workspaceRoot, {
          ...updated,
          worktreePath,
          worktreeBranch,
        });
      }
    } catch {
      // ignore manifest failure sync error
    }
    throw err;
  }

  if (worktreePath) {
    const disk = readManifest(executionRoot);
    archiveManifest(workspaceRoot, {
      ...(disk ?? manifest),
      status: execRes.status,
      worktreePath,
      worktreeBranch,
      changedFiles: execRes.changedFiles,
      artifacts: execRes.artifacts,
      metrics: execRes.metrics ?? disk?.metrics,
      errorCode: execRes.errorCode,
      error: execRes.errorMessage ? maskSecrets(execRes.errorMessage) : undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    ok: execRes.status === 'VERIFIED',
    taskId,
    mode: resolvedMode,
    status: execRes.status,
    gitCheckpointRef: checkpoint.checkpointRef,
    ...(worktreePath ? { worktreePath } : {}),
    ...(worktreeBranch ? { worktreeBranch } : {}),
    changedFiles: execRes.changedFiles,
    artifacts: execRes.artifacts,
    reportMarkdown: maskSecrets(execRes.reportMarkdown),
    structuredOutput: execRes.structuredOutput,
    metrics: execRes.metrics,
    warnings: [...warnings, ...execRes.warnings],
    errorCode: execRes.errorCode,
    errorMessage: execRes.errorMessage ? maskSecrets(execRes.errorMessage) : undefined,
  };
}

export async function handleRollbackAgTask(
  input: RollbackToolInput,
  jobDeps?: Pick<JobDependencies, 'jobManager'>,
): Promise<RollbackToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const currentManifest = readManifest(workspaceRoot);

  let targetManifest: BridgeManifest | null = null;
  let fromArchive = false;

  if (input.taskId) {
    if (currentManifest?.taskId === input.taskId) {
      targetManifest = currentManifest;
      fromArchive = false;
    } else {
      targetManifest = readArchivedManifest(workspaceRoot, input.taskId);
      fromArchive = true;
    }
  } else {
    const allManifests = readAllTaskManifests(workspaceRoot);
    const newest = allManifests[0] ?? null;
    if (currentManifest) {
      // If a newer worktree task ran after the main workspace's last task, do not silently roll back
      // the older main workspace task when taskId is omitted (H-07).
      if (newest && newest.taskId !== currentManifest.taskId && newest.worktreePath) {
        throw new AgPluginError(
          'ROLLBACK_NO_CHECKPOINT',
          `Most recent task "${newest.taskId}" ran in an isolated worktree while main workspace manifest is "${currentManifest.taskId}". Specify taskId explicitly (e.g. "${newest.taskId}" or "${currentManifest.taskId}") to avoid rolling back the wrong workspace.`,
        );
      }
      targetManifest = currentManifest;
      fromArchive = false;
    } else if (newest && newest.worktreePath) {
      targetManifest = newest;
      fromArchive = true;
    }
  }

  if (!targetManifest) {
    throw new AgPluginError(
      'ROLLBACK_NO_CHECKPOINT',
      input.taskId
        ? `No task manifest found for taskId "${input.taskId}".`
        : 'No active or recent delegation manifest found in .ag-bridge/manifest.json.',
    );
  }

  // Only honor worktree removal for archived worktree manifests: a main-workspace agent can edit
  // parent `.ag-bridge/manifest.json` and must never bypass main rollback by injecting worktreePath.
  if (fromArchive && targetManifest.worktreePath) {
    const safeId = assertSafeTaskId(targetManifest.taskId);
    const safeWtRoot = resolveSafeWorktreeRoot(workspaceRoot, safeId, targetManifest.worktreePath);
    if (!safeWtRoot) {
      throw new AgPluginError(
        'PATH_TRAVERSAL_BLOCKED',
        `Refusing to remove worktree: recorded path "${targetManifest.worktreePath}" does not match .ag-bridge/worktrees/${safeId}.`,
      );
    }

    const manager = jobDeps?.jobManager ?? defaultJobManager;
    const liveJob = manager.get(safeId);
    let wtManifest: BridgeManifest | null = null;
    if (fs.existsSync(safeWtRoot)) {
      try {
        wtManifest = readManifest(safeWtRoot);
      } catch {
        wtManifest = null;
      }
    }
    const archiveStillActive =
      targetManifest.status === 'DISPATCHED' || targetManifest.status === 'RUNNING';
    if (
      liveJob?.active ||
      (archiveStillActive &&
        wtManifest?.taskId === safeId &&
        (wtManifest.status === 'DISPATCHED' || wtManifest.status === 'RUNNING'))
    ) {
      throw new AgPluginError(
        'BRIDGE_BUSY',
        `Worktree task "${safeId}" is currently running. Cancel it first with cancel_ag_job before removing its worktree.`,
      );
    }

    const expectedBranch = `${WORKTREE_BRANCH_PREFIX}${safeId}`;
    const wtRes = removeTaskWorktree(workspaceRoot, safeWtRoot, expectedBranch, true);
    if (wtRes.removed) {
      archiveManifest(workspaceRoot, {
        ...targetManifest,
        status: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
    }
    return {
      ok: wtRes.removed,
      taskId: targetManifest.taskId,
      restoredCheckpointRef: targetManifest.gitCheckpointRef,
      revertedTrackedFiles: [],
      removedUntrackedFiles: [],
      worktreeRemoved: wtRes.removed,
      worktreeBranchDeleted: wtRes.branchDeleted,
      ...(wtRes.warning ? { warnings: [wtRes.warning] } : {}),
    };
  }

  const rollbackRes = rollbackCheckpoint(workspaceRoot, targetManifest);

  if (currentManifest && currentManifest.taskId === targetManifest.taskId) {
    const resetManifest: BridgeManifest = {
      ...currentManifest,
      status: 'IDLE',
      updatedAt: new Date().toISOString(),
    };
    writeManifest(workspaceRoot, resetManifest);
  }

  return {
    ok: true,
    taskId: targetManifest.taskId,
    restoredCheckpointRef: rollbackRes.restoredCheckpointRef,
    revertedTrackedFiles: rollbackRes.revertedTrackedFiles,
    removedUntrackedFiles: rollbackRes.removedUntrackedFiles,
    restoredUntrackedFiles: rollbackRes.restoredUntrackedFiles,
    ...(rollbackRes.quarantineDir ? { quarantineDir: rollbackRes.quarantineDir } : {}),
    preRollbackHead: rollbackRes.preRollbackHead,
    ...(rollbackRes.preRollbackRef ? { preRollbackRef: rollbackRes.preRollbackRef } : {}),
    ...(rollbackWarnings(rollbackRes).length > 0 ? { warnings: rollbackWarnings(rollbackRes) } : {}),
  };
}

function rollbackWarnings(res: ReturnType<typeof rollbackCheckpoint>): string[] {
  const warnings: string[] = [];
  if (res.untrackedBaselineMissing) {
    warnings.push(
      'Untracked files were left in place: the checkpoint has no record of which untracked files existed before delegation, so none were removed.',
    );
  }
  if (res.untrackedSnapshotMissing) {
    warnings.push(
      "The checkpoint's copy of your untracked files is gone (recovery folders are kept for the last 10 tasks or 7 days), so files the agent edited or deleted were not put back.",
    );
  }
  if (res.pathsBehindLinks.length > 0) {
    warnings.push(
      `Left alone because a link (a junction) lies on the way to them, which may lead outside the workspace: ${res.pathsBehindLinks.join(', ')}.`,
    );
  }
  return warnings;
}

export function createAntigravityMcpServer(deps: ServerDependencies = {}): McpServer {
  const server = new McpServer({
    name: 'antigravity-delegate',
    version: '1.6.1',
  });

  const sharedDelegateSchema = {
    title: z.string().min(3).max(120),
    instructions: z.string().min(5),
    lockedPaths: z.array(z.string().min(1)).optional(),
    verifyUrl: z.string().url().optional(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
    modeOverride: z.enum(['auto', 'subscription', 'api']).optional(),
    timeoutSec: z.number().int().min(5).max(3600).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    agent: z.string().min(1).optional(),
    agyMode: z.enum(['accept-edits', 'auto', 'plan']).optional(),
    sandbox: z.boolean().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    addDirs: z.array(z.string().min(1)).optional(),
    continueConversation: z.boolean().optional(),
    conversationId: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    newProject: z.boolean().optional(),
    remoteAgent: z.boolean().optional(),
    jsonSchema: z.string().min(1).optional(),
    disableSlashCommands: z.boolean().optional(),
    settings: z.string().min(1).optional(),
    rawPrompt: z.boolean().optional(),
    isolateWorktree: z.boolean().optional(),
    workspaceRoot: z.string().min(1).optional(),
  };

  server.tool(
    'delegate_to_antigravity',
    'Create a Git safety checkpoint, dispatch any task to Antigravity (full `agy` CLI feature set including native `/boost`, `/browser`, `/swarm`, `/goal`, models, effort, agents, conversation resume, `--json-schema`, sandbox, and `--dangerously-skip-permissions`, or Gemini API fallback), and wait for the verification report, structured output, artifacts, and token usage metrics.',
    sharedDelegateSchema,
    async (args, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const onProgress: ProgressCallback | undefined =
          progressToken !== undefined
            ? (ev) => {
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: ev.progress,
                      ...(ev.total !== undefined ? { total: ev.total } : {}),
                      message: maskSecrets(ev.message),
                    },
                  })
                  .catch(() => {
                    // Best-effort notification: ignore transport/client errors
                  });
              }
            : undefined;
        const result = await handleDelegateToAntigravity(args, deps, {
          onProgress,
          abortSignal: extra.signal,
        });
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] delegate_to_antigravity error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'check_ag_environment',
    'Inspect detected Antigravity execution mode (subscription vs api), local CLI/app paths, active agy CLI permission/model config, API key status (redacted), Git Guard status, and bridge/usage state.',
    {
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleCheckEnvironment(args.workspaceRoot, deps);
        return toJsonToolResponse(result, false);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] check_ag_environment error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'rollback_ag_task',
    'Restore the workspace to its exact pre-delegation Git checkpoint state using gitCheckpointRef while preserving pre-existing untracked files.',
    {
      taskId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleRollbackAgTask(args, deps.jobDeps);
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] rollback_ag_task error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'list_ag_capabilities',
    'Discover available Antigravity CLI models (`agy models`), agents (`agy agents`), supported permission modes (including `--dangerously-skip-permissions`), effort levels, and active default flags.',
    {
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleListCapabilities(args.workspaceRoot, deps);
        return toJsonToolResponse(result, false);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] list_ag_capabilities error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'get_ag_usage',
    'Aggregate token usage (input, output, thinking, cache read, total), turn counts, and duration across the current and archived Antigravity delegation tasks.',
    {
      workspaceRoot: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      try {
        const result = await handleGetUsage(args.workspaceRoot, args.limit ?? 20);
        return toJsonToolResponse(result, false);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] get_ag_usage error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'ag_auth',
    'Authenticate Antigravity CLI (`agy acp --login`) with Google OAuth directly from Claude Code (local browser or headless/manual link+code flow), check live login status, complete or cancel a pending code-paste login, or view safe logout steps.',
    {
      action: z.enum(['status', 'login', 'complete', 'cancel', 'logout']).optional(),
      flow: z.enum(['auto', 'browser', 'manual']).optional(),
      force: z.boolean().optional(),
      code: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      timeoutSec: z.number().int().min(15).max(600).optional(),
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleAgAuth(args, {
          detectorDeps: deps.detectorDeps,
          queryCapabilitiesFn: deps.queryCapabilitiesFn,
          ...deps.authDeps,
        });
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] ag_auth error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'start_ag_task',
    'Non-blocking background delegation: creates a Git safety checkpoint, launches Antigravity (`agy` CLI or Gemini API) asynchronously in the background, and immediately returns a `jobId` so Claude Code can continue other work in parallel. Poll or collect results with `get_ag_job`, or stop with `cancel_ag_job`.',
    sharedDelegateSchema,
    async (args) => {
      try {
        const result = await handleStartAgTask(args, {
          pluginRoot: deps.pluginRoot,
          detectorDeps: deps.detectorDeps,
          subscriptionEngine: deps.subscriptionEngine,
          apiWorkerEngine: deps.apiWorkerEngine,
          ...deps.jobDeps,
        });
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] start_ag_task error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'get_ag_job',
    'Inspect a specific background Antigravity job by `jobId` (including live progress, token usage, masked log tail, reportMarkdown, structuredOutput, changedFiles, and artifacts) or list active and recent background jobs when `jobId` is omitted.',
    {
      jobId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
      includeLogTail: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      try {
        const result = await handleGetAgJob(args, deps.jobDeps);
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] get_ag_job error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'cancel_ag_job',
    'Gracefully cancel a running background Antigravity job (terminating its child process tree and marking `.ag-bridge/manifest.json` as FAILED/TASK_CANCELLED). Preserves the pre-delegation Git checkpoint for optional `rollback_ag_task`.',
    {
      jobId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleCancelAgJob(args, deps.jobDeps);
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] cancel_ag_job error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'ag_session',
    'Manage persistent multi-turn Antigravity `stream-json` sessions (`start`, `send`, `list`, `close`) using `agy --input-format stream-json --output-format stream-json` for zero cold-start latency and high cache-hit token savings across turns.',
    {
      action: z.enum(['start', 'send', 'list', 'close']),
      sessionId: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      agent: z.string().min(1).optional(),
      agyMode: z.enum(['accept-edits', 'auto', 'plan']).optional(),
      sandbox: z.boolean().optional(),
      dangerouslySkipPermissions: z.boolean().optional(),
      addDirs: z.array(z.string().min(1)).optional(),
      continueConversation: z.boolean().optional(),
      conversationId: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
      remoteAgent: z.boolean().optional(),
      jsonSchema: z.string().min(1).optional(),
      disableSlashCommands: z.boolean().optional(),
      settings: z.string().min(1).optional(),
      timeoutSec: z.number().int().min(5).max(3600).optional(),
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleAgSession(args, {
          detectorDeps: deps.detectorDeps,
          ...deps.sessionDeps,
        });
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] ag_session error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'list_ag_artifacts',
    'List screenshots, logs, reports, and JSON artifacts under `.ag-bridge/artifacts/<taskId>/`, along with masked `report.md` and `agy-cli.log` tail previews.',
    {
      taskId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
      includeReport: z.boolean().optional(),
      includeLogTail: z.boolean().optional(),
      logTailLines: z.number().int().min(5).max(200).optional(),
    },
    async (args) => {
      try {
        const result = handleListArtifacts(args);
        return toJsonToolResponse(result, false);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] list_ag_artifacts error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  server.tool(
    'ag_cli_admin',
    'Manage Antigravity CLI platform integrations safely (`mcp_list`, `mcp_add`, `mcp_remove`, `mcp_enable`, `mcp_disable`, `mcp_sync_from_claude`, `remote_status`, `remote_start`, `remote_stop`, `changelog`, `update`).',
    {
      action: z.enum([
        'mcp_list',
        'mcp_add',
        'mcp_remove',
        'mcp_enable',
        'mcp_disable',
        'mcp_sync_from_claude',
        'remote_status',
        'remote_start',
        'remote_stop',
        'changelog',
        'update',
      ]),
      name: z.string().min(1).optional(),
      commandOrUrl: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
      serverType: z.enum(['stdio', 'http']).optional(),
      envVars: z.array(z.string().min(1)).optional(),
      headers: z.array(z.string().min(1)).optional(),
      dryRun: z.boolean().optional(),
      maxLines: z.number().int().min(10).max(300).optional(),
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleAgCliAdmin(args, {
          detectorDeps: deps.detectorDeps,
          ...deps.cliAdminDeps,
        });
        return toJsonToolResponse(result, !result.ok);
      } catch (err) {
        const code = err instanceof AgPluginError ? err.code : 'INTERNAL_ERROR';
        const message = maskSecrets(err instanceof Error ? err.message : String(err));
        console.error(`[antigravity-delegate] ag_cli_admin error (${code}): ${message}`);
        return toJsonToolResponse(
          { ok: false, errorCode: code, errorMessage: message },
          true,
        );
      }
    },
  );

  return server;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  process.once('exit', () => {
    disposePendingAuthSessions();
    disposeActiveJobs();
    disposePersistentSessions();
  });
  const server = createAntigravityMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error(
      `[antigravity-delegate] Fatal MCP server startup error: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    process.exit(1);
  });
}
