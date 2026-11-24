import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { requireExecutable } from './exec-path.js';
import { AgPluginError, BridgeManifest, GitGuardPolicy, GitStatusInfo } from './types.js';

/**
 * Git Guard's plumbing runs no command the repository configures: a repository delivered with its
 * `.git/` can set `core.fsmonitor` (run by status and stash create), ship hooks (reference-transaction
 * runs on update-ref), and — as a partial clone — make `reset --hard` lazily fetch through a remote
 * whose `core.sshCommand` it chose (all measured). Git Guard never needs the network, so every
 * transport is refused. Clean/smudge filters stay on: checkpoints must store real content (Git
 * LFS). ARC-003 §8, TC-S20 ~ TC-S20c.
 */
const NO_REPO_COMMANDS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
];

/**
 * How long Git Guard waits for one git command. execFileSync blocks the whole MCP server, and a
 * repository's clean filter (left on, above) can stall `git status` for as long as it likes
 * (TC-U34). AG_GIT_TIMEOUT_MS raises it for very large repositories.
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

function gitTimeoutMs(): number {
  const configured = Number(process.env.AG_GIT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_GIT_TIMEOUT_MS;
}

function runGit(workspaceRoot: string, args: string[]): string {
  // By absolute path: a bare `git` runs a git the workspace ships once PATH holds "." (TC-S14).
  return execFileSync(requireExecutable('git'), [...NO_REPO_COMMANDS, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: gitTimeoutMs(),
    // the 1 MiB default fails `ls-files` in a tree with tens of thousands of untracked files
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function tryRunGit(
  workspaceRoot: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; timedOut: boolean } {
  try {
    const stdout = runGit(workspaceRoot, args);
    return { ok: true, stdout, stderr: '', timedOut: false };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : err instanceof Error
          ? err.message
          : String(err);
    const timedOut = Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'ETIMEDOUT');
    return { ok: false, stdout: '', stderr, timedOut };
  }
}

const isBridgePath = (p: string): boolean => p === '.ag-bridge' || p.startsWith('.ag-bridge/');

/** Whether git tracks a file matching `pathspec` (pathspec magic allowed). False outside a repository. */
export function isTrackedFile(workspaceRoot: string, pathspec: string): boolean {
  return tryRunGit(workspaceRoot, ['ls-files', '--error-unmatch', '--', pathspec]).ok;
}

export function getGitInfo(workspaceRoot: string): GitStatusInfo {
  // Single subprocess (`git status --porcelain=v1 -b`) reduces latency ~3x vs 3 separate git calls
  const statusRes = tryRunGit(workspaceRoot, ['status', '--porcelain=v1', '-b']);
  if (!statusRes.ok) {
    return statusRes.timedOut
      ? { isGitRepo: false, error: `Git did not answer within ${gitTimeoutMs()} ms` }
      : { isGitRepo: false };
  }

  const lines = statusRes.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0] ?? '';
  let currentBranch: string | undefined;

  if (header.startsWith('## ')) {
    const branchPart = header.slice(3).trim();
    if (branchPart.startsWith('No commits yet on ')) {
      currentBranch = branchPart.slice('No commits yet on '.length).trim();
    } else if (branchPart.startsWith('HEAD (no branch)')) {
      currentBranch = 'HEAD';
    } else {
      currentBranch = branchPart.split('...')[0].trim();
    }
  }

  return {
    isGitRepo: true,
    currentBranch,
    isDirty: lines.length > 1,
  };
}

// Path lists are read with -z: without it git quotes non-ASCII names ("\354\202\254…"), which then
// name no file — a rollback left the agent's 에이전트결과.txt behind (TC-U35).

export function listGitChangedFiles(workspaceRoot: string): string[] {
  const res = tryRunGit(workspaceRoot, ['status', '--porcelain=v1', '-z']);
  if (!res.ok) {
    return [];
  }
  const files = new Set<string>();
  const entries = res.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    // "XY path", and for a rename or copy the next entry is the original path
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    const file = entry.slice(3);
    if (!isBridgePath(file)) files.add(file);
  }
  return Array.from(files).sort();
}

/**
 * The untracked files, or undefined when git could not list them. A failed listing is not "none":
 * a baseline recorded as [] would make a later rollback delete every untracked file (TC-S22b).
 */
export function listUntrackedFiles(workspaceRoot: string): string[] | undefined {
  const res = tryRunGit(workspaceRoot, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (!res.ok) {
    return undefined;
  }
  return res.stdout
    .split('\0')
    .filter((file) => file.length > 0 && !isBridgePath(file))
    .sort();
}

export interface CheckpointResult {
  checkpointRef?: string;
  isStashSnapshot: boolean;
  /** Untracked files before delegation; undefined when git could not list them. */
  untrackedBaseline: string[] | undefined;
  warning?: string;
}

export function createCheckpoint(
  workspaceRoot: string,
  taskId: string,
  policy: GitGuardPolicy,
): CheckpointResult {
  const gitInfo = getGitInfo(workspaceRoot);
  if (!gitInfo.isGitRepo) {
    const why = gitInfo.error ?? 'Workspace is not a Git repository';
    if (policy === 'required') {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `${why} and git_guard policy is set to "required".`,
      );
    }
    return {
      checkpointRef: undefined,
      isStashSnapshot: false,
      untrackedBaseline: [],
      warning: `${why}; automatic rollback checkpoint is disabled.`,
    };
  }

  const headRes = tryRunGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!headRes.ok) {
    if (policy === 'required') {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        'Git repository has no initial commit (unborn HEAD); cannot create checkpoint.',
      );
    }
    return {
      checkpointRef: undefined,
      isStashSnapshot: false,
      untrackedBaseline: listUntrackedFiles(workspaceRoot),
      warning: 'Git repository has no commits yet (unborn HEAD); rollback checkpoint is disabled.',
    };
  }

  const untrackedBaseline = listUntrackedFiles(workspaceRoot);
  if (untrackedBaseline === undefined) {
    // Without the list a rollback could not tell the user's untracked files from the agent's.
    const why = 'Git could not list the untracked files';
    if (policy === 'required') {
      throw new AgPluginError('GIT_CHECKPOINT_FAILED', `${why}; no checkpoint can be rolled back safely.`);
    }
    return {
      checkpointRef: undefined,
      isStashSnapshot: false,
      untrackedBaseline: undefined,
      warning: `${why}; automatic rollback checkpoint is disabled.`,
    };
  }
  const stashRes = tryRunGit(workspaceRoot, ['stash', 'create', `ag-bridge-checkpoint-${taskId}`]);
  if (!stashRes.ok) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      `Failed to create git stash snapshot: ${stashRes.stderr}`,
    );
  }

  const stashHash = stashRes.stdout.trim();
  if (stashHash) {
    const refName = `refs/ag-bridge/checkpoints/${taskId}`;
    const pinRes = tryRunGit(workspaceRoot, ['update-ref', refName, stashHash]);
    if (!pinRes.ok) {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `Failed to pin git checkpoint ref ${refName}: ${pinRes.stderr}`,
      );
    }
    return {
      checkpointRef: stashHash,
      isStashSnapshot: true,
      untrackedBaseline,
    };
  }

  return {
    checkpointRef: headRes.stdout.trim(),
    isStashSnapshot: false,
    untrackedBaseline,
  };
}

export interface RollbackResult {
  restoredCheckpointRef: string;
  revertedTrackedFiles: string[];
  removedUntrackedFiles: string[];
  /** The checkpoint recorded no untracked baseline, so no untracked file was removed. */
  untrackedBaselineMissing: boolean;
}

export function rollbackCheckpoint(
  workspaceRoot: string,
  manifest: BridgeManifest,
): RollbackResult {
  if (!manifest.gitCheckpointRef) {
    throw new AgPluginError(
      'ROLLBACK_NO_CHECKPOINT',
      `Task "${manifest.taskId}" does not have a valid gitCheckpointRef for rollback.`,
    );
  }

  const gitInfo = getGitInfo(workspaceRoot);
  if (!gitInfo.isGitRepo) {
    throw new AgPluginError(
      'ROLLBACK_NO_CHECKPOINT',
      'Workspace is not a Git repository; cannot perform Git rollback.',
    );
  }

  const beforeDiff = listGitChangedFiles(workspaceRoot);
  const ref = manifest.gitCheckpointRef;

  if (manifest.gitCheckpointIsStash) {
    const resetRes = tryRunGit(workspaceRoot, ['reset', '--hard', 'HEAD']);
    if (!resetRes.ok) {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `Failed to reset working tree before restoring dirty snapshot: ${resetRes.stderr}`,
      );
    }
    const applyIdx = tryRunGit(workspaceRoot, ['stash', 'apply', '--index', ref]);
    if (!applyIdx.ok) {
      const applyFallback = tryRunGit(workspaceRoot, ['stash', 'apply', ref]);
      if (!applyFallback.ok) {
        throw new AgPluginError(
          'GIT_CHECKPOINT_FAILED',
          `Failed to apply checkpoint snapshot ${ref}: ${applyFallback.stderr}`,
        );
      }
    }
  } else {
    const resetRes = tryRunGit(workspaceRoot, ['reset', '--hard', ref]);
    if (!resetRes.ok) {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `Failed to reset working tree to checkpoint ${ref}: ${resetRes.stderr}`,
      );
    }
  }

  // Remove only untracked files created after delegation began. With no baseline (an older
  // manifest, or one written by hand) nothing tells the user's files from the agent's: keep all
  // (TC-S22). A failed listing now removes nothing either.
  const baseline = manifest.gitUntrackedBaseline;
  const untrackedBaselineMissing = baseline === undefined;
  const removedUntrackedFiles: string[] = [];

  if (!untrackedBaselineMissing) {
    const baselineSet = new Set(baseline);
    for (const relFile of listUntrackedFiles(workspaceRoot) ?? []) {
      if (baselineSet.has(relFile)) {
        continue;
      }
      const fullPath = path.resolve(workspaceRoot, relFile);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedUntrackedFiles.push(relFile);
      }
    }
  }

  // Clean up pinned ref if present
  tryRunGit(workspaceRoot, ['update-ref', '-d', `refs/ag-bridge/checkpoints/${manifest.taskId}`]);

  const removedSet = new Set(removedUntrackedFiles);
  const revertedTrackedFiles = beforeDiff.filter((f) => !removedSet.has(f));

  return {
    restoredCheckpointRef: ref,
    revertedTrackedFiles,
    removedUntrackedFiles,
    untrackedBaselineMissing,
  };
}
