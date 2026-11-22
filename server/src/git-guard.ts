import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AgPluginError, BridgeManifest, GitGuardPolicy, GitStatusInfo } from './types.js';

function runGit(workspaceRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function tryRunGit(workspaceRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = runGit(workspaceRoot, args);
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, stdout: '', stderr };
  }
}

export function getGitInfo(workspaceRoot: string): GitStatusInfo {
  const inside = tryRunGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isGitRepo: false };
  }

  const branchRes = tryRunGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusRes = tryRunGit(workspaceRoot, ['status', '--porcelain']);

  return {
    isGitRepo: true,
    currentBranch: branchRes.ok ? branchRes.stdout.trim() : undefined,
    isDirty: statusRes.ok ? statusRes.stdout.trim().length > 0 : undefined,
  };
}

export function listGitChangedFiles(workspaceRoot: string): string[] {
  const res = tryRunGit(workspaceRoot, ['status', '--porcelain']);
  if (!res.ok || !res.stdout.trim()) {
    return [];
  }
  const files = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Porcelain format: XY <path> (or XY <old> -> <new>)
    const rawPath = line.slice(3).trim();
    const finalPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()!.trim() : rawPath;
    const unquoted = finalPath.replace(/^"|"$/g, '');
    if (unquoted && !unquoted.startsWith('.ag-bridge/') && unquoted !== '.ag-bridge') {
      files.add(unquoted);
    }
  }
  return Array.from(files).sort();
}

export function listUntrackedFiles(workspaceRoot: string): string[] {
  const res = tryRunGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard']);
  if (!res.ok || !res.stdout.trim()) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('.ag-bridge/') && line !== '.ag-bridge')
    .sort();
}

export interface CheckpointResult {
  checkpointRef?: string;
  isStashSnapshot: boolean;
  untrackedBaseline: string[];
  warning?: string;
}

export function createCheckpoint(
  workspaceRoot: string,
  taskId: string,
  policy: GitGuardPolicy,
): CheckpointResult {
  const gitInfo = getGitInfo(workspaceRoot);
  if (!gitInfo.isGitRepo) {
    if (policy === 'required') {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        'Workspace is not a Git repository and git_guard policy is set to "required".',
      );
    }
    return {
      checkpointRef: undefined,
      isStashSnapshot: false,
      untrackedBaseline: [],
      warning: 'Workspace is not a Git repository; automatic rollback checkpoint is disabled.',
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

  // Remove only untracked files created after delegation began
  const baselineSet = new Set(manifest.gitUntrackedBaseline ?? []);
  const currentUntracked = listUntrackedFiles(workspaceRoot);
  const removedUntrackedFiles: string[] = [];

  for (const relFile of currentUntracked) {
    if (baselineSet.has(relFile)) {
      continue;
    }
    const fullPath = path.resolve(workspaceRoot, relFile);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removedUntrackedFiles.push(relFile);
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
  };
}
