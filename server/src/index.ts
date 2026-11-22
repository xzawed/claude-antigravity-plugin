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
import { SubscriptionEngine } from './engines/subscription.js';
import { createCheckpoint, getGitInfo, rollbackCheckpoint } from './git-guard.js';
import { validateLockedPathsConfig } from './path-guard.js';
import {
  AgPluginError,
  BridgeManifest,
  CheckEnvironmentOutput,
  DelegateToolInput,
  DelegateToolOutput,
  RollbackToolInput,
  RollbackToolOutput,
} from './types.js';
import fs from 'node:fs';

export interface ServerDependencies {
  pluginRoot?: string;
  detectorDeps?: DetectorDeps;
  subscriptionEngine?: ExecutionEngine;
  apiWorkerEngine?: ExecutionEngine;
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
    bridge: {
      initialized: fs.existsSync(getBridgeDir(workspaceRoot)),
      gitignoreProtected: isGitignoreProtected(workspaceRoot),
      currentStatus: manifest?.status ?? 'IDLE',
      lastTaskId: manifest?.taskId,
      lastUpdatedAt: manifest?.updatedAt,
    },
  };
}

export async function handleDelegateToAntigravity(
  input: DelegateToolInput,
  deps: ServerDependencies = {},
): Promise<DelegateToolOutput> {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const pluginRoot = deps.pluginRoot ?? getDefaultPluginRoot();
  const warnings: string[] = [];

  const config = loadConfig(workspaceRoot, deps.detectorDeps?.env ?? process.env);
  const normalizedLockedPaths = validateLockedPathsConfig(workspaceRoot, input.lockedPaths);

  const detection = detectEnvironment(
    config,
    input.modeOverride,
    deps.detectorDeps ?? getDefaultDetectorDeps(),
  );
  const resolvedMode = assertResolvedMode(detection);

  ensureBridgeDirs(workspaceRoot);
  ensureGitignoreEntry(workspaceRoot);

  const lockRes = acquireBridgeLock(workspaceRoot, config.subscription.timeout_sec);
  warnings.push(...lockRes.warnings);

  const taskId = generateTaskId();
  const checkpoint = createCheckpoint(workspaceRoot, taskId, config.git_guard);
  if (checkpoint.warning) {
    warnings.push(checkpoint.warning);
  }

  const now = new Date().toISOString();
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
    acceptanceCriteria: input.acceptanceCriteria,
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
    acceptanceCriteria: input.acceptanceCriteria,
    detection,
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
    version: '1.0.0',
  });

  server.tool(
    'delegate_to_antigravity',
    'Create a Git safety checkpoint, dispatch the task to Antigravity (local Subscription mode or Gemini API fallback), and return the verification report and artifacts.',
    {
      title: z.string().min(3).max(120),
      instructions: z.string().min(10),
      lockedPaths: z.array(z.string().min(1)).min(1),
      verifyUrl: z.string().url().optional(),
      acceptanceCriteria: z.array(z.string().min(1)).min(1),
      modeOverride: z.enum(['auto', 'subscription', 'api']).optional(),
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
    'Inspect detected Antigravity execution mode (subscription vs api), local CLI/app paths, API key configuration status (redacted), Git Guard status, and bridge state.',
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
