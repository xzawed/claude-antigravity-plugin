import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  acquireBridgeLock,
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
import { loadConfig, maskSecrets } from './config.js';
import {
  assertResolvedMode,
  detectEnvironment,
  DetectorDeps,
  getDefaultDetectorDeps,
} from './detector.js';
import { ApiWorkerEngine } from './engines/api-worker.js';
import { ExecutionEngine } from './engines/base.js';
import { queryAgyCapabilities, SubscriptionEngine } from './engines/subscription.js';
import { createCheckpoint, getGitInfo, rollbackCheckpoint } from './git-guard.js';
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
  ) =>
    | Awaited<ReturnType<typeof queryAgyCapabilities>>
    | ReturnType<typeof queryAgyCapabilities>;
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
    const cap = await queryFn(detection.subscription.cliPath, detection.platform);
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
  };
}

export async function handleDelegateToAntigravity(
  input: DelegateToolInput,
  deps: ServerDependencies = {},
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
    gitCheckpointRef: checkpoint.checkpointRef,
    gitCheckpointIsStash: checkpoint.isStashSnapshot,
    gitUntrackedBaseline: checkpoint.untrackedBaseline,
    artifacts: [],
  };

  writeManifest(workspaceRoot, manifest);
  writeDispatchMarkdown(workspaceRoot, {
    manifest,
    instructions: input.instructions,
    acceptanceCriteria,
  });

  const engine: ExecutionEngine =
    resolvedMode === 'subscription'
      ? (deps.subscriptionEngine ?? new SubscriptionEngine())
      : (deps.apiWorkerEngine ?? new ApiWorkerEngine());

  const execRes = await engine.execute({
    workspaceRoot,
    pluginRoot,
    manifest,
    config,
    instructions: input.instructions,
    acceptanceCriteria,
    detection,
    agyOptions: extractAgyOptions(input),
    timeoutSecOverride: input.timeoutSec,
  });

  return {
    ok: execRes.status === 'VERIFIED',
    taskId,
    mode: resolvedMode,
    status: execRes.status,
    gitCheckpointRef: checkpoint.checkpointRef,
    changedFiles: execRes.changedFiles,
    artifacts: execRes.artifacts,
    reportMarkdown: maskSecrets(execRes.reportMarkdown),
    metrics: execRes.metrics,
    warnings: [...warnings, ...execRes.warnings],
    errorCode: execRes.errorCode,
    errorMessage: execRes.errorMessage ? maskSecrets(execRes.errorMessage) : undefined,
  };
}

export async function handleRollbackAgTask(
  input: RollbackToolInput,
): Promise<RollbackToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const currentManifest = readManifest(workspaceRoot);

  let targetManifest: BridgeManifest | null = null;
  if (input.taskId) {
    if (currentManifest?.taskId === input.taskId) {
      targetManifest = currentManifest;
    } else {
      targetManifest = readArchivedManifest(workspaceRoot, input.taskId);
    }
  } else {
    targetManifest = currentManifest;
  }

  if (!targetManifest) {
    throw new AgPluginError(
      'ROLLBACK_NO_CHECKPOINT',
      input.taskId
        ? `No task manifest found for taskId "${input.taskId}".`
        : 'No active or recent delegation manifest found in .ag-bridge/manifest.json.',
    );
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
  };
}

export function createAntigravityMcpServer(deps: ServerDependencies = {}): McpServer {
  const server = new McpServer({
    name: 'antigravity-delegate',
    version: '1.1.0',
  });

  server.tool(
    'delegate_to_antigravity',
    'Create a Git safety checkpoint, dispatch any task to Antigravity (full `agy` CLI feature set including models, effort, agents, conversation resume, sandbox, and `--dangerously-skip-permissions`, or Gemini API fallback), and return the verification report, artifacts, and token usage metrics.',
    {
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
      workspaceRoot: z.string().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await handleDelegateToAntigravity(args, deps);
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
        const result = await handleRollbackAgTask(args);
        return toJsonToolResponse(result, false);
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

  return server;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const server = createAntigravityMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error(
      `[antigravity-delegate] Fatal MCP server startup error: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    process.exit(1);
  });
}
