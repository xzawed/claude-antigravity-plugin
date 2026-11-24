import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeTaskId, getBridgeDir } from './bridge-fs.js';
import { requireExecutable, resolveExecutable } from './exec-path.js';
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

export interface PosixGroupScan {
  members: number;
  includesSelf: boolean;
}

function scanPosixGroup(pgid: number): PosixGroupScan {
  const psPath = resolveExecutable('ps');
  if (!psPath) {
    return { members: 0, includesSelf: false };
  }
  try {
    const res = spawnSync(psPath, ['-eo', 'pid=,pgid='], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') {
      return { members: 0, includesSelf: false };
    }
    let members = 0;
    let includesSelf = false;
    for (const line of res.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && Number(parts[1]) === pgid) {
        if (Number(parts[0]) === process.pid) {
          includesSelf = true;
        } else {
          members += 1;
        }
      }
    }
    return { members, includesSelf };
  } catch {
    return { members: 0, includesSelf: false };
  }
}

/**
 * Resolve a POSIX wrapper that places the child git process in its own process group (`PGID === pid`)
 * before `exec`ing `gitBin` in-place. Node.js `spawnSync` does not honor `detached: true`, so without
 * this wrapper a timed-out git's clean/smudge filter children are reparented to PID 1 while sharing
 * the MCP server's own process group.
 * - Linux: `setsid -- <git> ...` (native util-linux binary; child is not a group leader so no fork)
 * - macOS / fallback: `perl -e 'setpgrp(0,0); exec { $ARGV[0] } @ARGV or exit 127' <git> ...`
 */
function buildPosixGitCommand(
  gitBin: string,
  gitArgs: string[],
): { command: string; args: string[]; isolatedGroup: boolean } {
  const setsidPath = resolveExecutable('setsid');
  if (setsidPath) {
    return {
      command: setsidPath,
      args: ['--', gitBin, ...gitArgs],
      isolatedGroup: true,
    };
  }
  const perlPath = resolveExecutable('perl');
  if (perlPath) {
    return {
      command: perlPath,
      args: ['-e', 'setpgrp(0,0); exec { $ARGV[0] } @ARGV or exit 127', gitBin, ...gitArgs],
      isolatedGroup: true,
    };
  }
  return {
    command: gitBin,
    args: gitArgs,
    isolatedGroup: false,
  };
}

/**
 * End any filter/helper subprocesses left running in a timed-out git's POSIX process group.
 * Because `tryRunGit` places POSIX git calls in their own process group (`PGID === pid`), any
 * clean/smudge filter spawned by git inherits that PGID even after git exits and is reaped, so
 * `kill(-pgid, 'SIGKILL')` stops the whole tree without racing reparenting to PID 1
 * (ARC-003 §5.4, TC-U34d ~ TC-U34e).
 */
export function endPosixLeftovers(
  pgid: number,
  killFn: (pid: number, signal?: NodeJS.Signals | number) => boolean = process.kill.bind(process),
  scanFn: (pgid: number) => PosixGroupScan = scanPosixGroup,
): number {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return 0;
  }
  const firstScan = scanFn(pgid);
  if (firstScan.includesSelf) {
    return 0;
  }
  try {
    killFn(-pgid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
      return 0;
    }
  }
  try {
    killFn(-pgid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
      return 0;
    }
  }
  const secondScan = scanFn(pgid);
  if (!secondScan.includesSelf && secondScan.members > 0) {
    try {
      killFn(-pgid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  return Math.max(firstScan.members + (secondScan.includesSelf ? 0 : secondScan.members), 1);
}

/**
 * End what a timed-out git left running on Windows, and say how many processes that was.
 *
 * `git` on PATH is usually Git for Windows' launcher (cmd\git.exe). The time limit kills only the
 * launcher; the real git it started runs on through its filters and holds the work tree (measured:
 * still running after the cut, gone at 6.9 s; TC-U34b). Running mingw64\bin\git.exe directly is no
 * way out: with the launcher's PATH its sh filters fail ("cannot spawn sh") while status and
 * `stash create` still exit 0.
 *
 * One PowerShell walks the ParentProcessId links down from the launcher and stops each process
 * found. A child must have been created between the launcher's start and the cut, and a deeper one
 * after its parent, so a reused pid is never followed. Best effort: 0 when anything fails.
 */
function endWindowsLeftovers(launcherPid: number, startedAt: Date, cutAt: Date): number {
  // Times are compared in UTC throughout (a local-time compare breaks across a DST fall-back), the
  // window is tight (the launcher's children were all made before the cut), and a second look stops
  // what a found process started between the listing and its stop (reviewers' points, ARC-003 §5.4).
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "function Get-Procs { @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, @{ n = 'Created'; e = { $_.CreationDate.ToUniversalTime() } }) }",
    '$all = Get-Procs',
    `$from = [datetime]::Parse('${startedAt.toISOString()}').ToUniversalTime().AddSeconds(-1)`,
    `$to = [datetime]::Parse('${cutAt.toISOString()}').ToUniversalTime().AddMilliseconds(250)`,
    `$queue = @($all | Where-Object { $_.ParentProcessId -eq ${launcherPid} -and $_.Created -ge $from -and $_.Created -le $to })`,
    '$found = @()',
    '$seen = @{}',
    'while ($queue.Count -gt 0) { $p = $queue[0]; $queue = @($queue | Select-Object -Skip 1); if ($seen.ContainsKey($p.ProcessId)) { continue }; $seen[$p.ProcessId] = $true; $found += $p; $queue += @($all | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.Created -ge $p.Created -and -not $seen.ContainsKey($_.ProcessId) }) }',
    'foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force }',
    '$late = @(Get-Procs | Where-Object { $c = $_; @($found | Where-Object { $_.ProcessId -eq $c.ParentProcessId -and $c.Created -ge $_.Created }).Count -gt 0 })',
    'foreach ($p in $late) { Stop-Process -Id $p.ProcessId -Force }',
    '$found.Count + $late.Count',
  ].join('; ');
  try {
    const out = execFileSync(requireExecutable('powershell'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      windowsHide: true,
    });
    const ended = Number(out.trim().split(/\r?\n/).pop());
    return Number.isInteger(ended) && ended > 0 ? ended : 0;
  } catch {
    return 0;
  }
}

function tryRunGit(
  workspaceRoot: string,
  args: string[],
  input?: string,
): { ok: boolean; stdout: string; stderr: string; timedOut: boolean; leftoversEnded: number } {
  const startedAt = new Date();
  let gitBin: string;
  try {
    // By absolute path: a bare `git` runs a git the workspace ships once PATH holds "." (TC-S14).
    gitBin = requireExecutable('git');
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr, timedOut: false, leftoversEnded: 0 };
  }

  const fullGitArgs = [...NO_REPO_COMMANDS, ...args];
  const launch =
    process.platform === 'win32'
      ? { command: gitBin, args: fullGitArgs, isolatedGroup: false }
      : buildPosixGitCommand(gitBin, fullGitArgs);

  const res = spawnSync(launch.command, launch.args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    timeout: gitTimeoutMs(),
    // the 1 MiB default fails `ls-files` in a tree with tens of thousands of untracked files
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (!res.error && res.status === 0 && res.signal === null) {
    return {
      ok: true,
      stdout: (res.stdout ?? '').trimEnd(),
      stderr: '',
      timedOut: false,
      leftoversEnded: 0,
    };
  }

  const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errCode === 'ETIMEDOUT';
  const pid = res.pid;
  const leftoversEnded =
    timedOut && typeof pid === 'number' && Number.isInteger(pid) && pid > 0
      ? process.platform === 'win32'
        ? endWindowsLeftovers(pid, startedAt, new Date())
        : launch.isolatedGroup
          ? endPosixLeftovers(pid)
          : 0
      : 0;
  const cleanup =
    leftoversEnded > 0
      ? ` (ended ${leftoversEnded} process${leftoversEnded === 1 ? '' : 'es'} it left running)`
      : '';
  const rawStderr =
    typeof res.stderr === 'string' && res.stderr.length > 0
      ? res.stderr
      : res.error instanceof Error
        ? res.error.message
        : res.error
          ? String(res.error)
          : '';
  const stderr =
    timedOut && rawStderr.trim().length === 0
      ? `Git did not answer within ${gitTimeoutMs()} ms${cleanup}`
      : rawStderr;
  return { ok: false, stdout: '', stderr, timedOut, leftoversEnded };
}

const isBridgePath = (p: string): boolean => p === '.ag-bridge' || p.startsWith('.ag-bridge/');

/**
 * Check whether git tracks a file matching `pathspec` (pathspec magic allowed).
 * Uses `ls-files -z` (exit 0 with empty stdout = definite `'untracked'`, non-empty = `'tracked'`,
 * non-zero exit / timeout / missing binary / non-repo = `'unknown'`), so callers do not depend on
 * localized stderr strings and can fail-closed when a repository is present.
 */
export function checkTrackedFile(
  workspaceRoot: string,
  pathspec: string,
): 'tracked' | 'untracked' | 'unknown' {
  const res = tryRunGit(workspaceRoot, ['ls-files', '-z', '--', pathspec]);
  if (!res.ok) {
    return 'unknown';
  }
  return res.stdout.length > 0 ? 'tracked' : 'untracked';
}

/** Whether git tracks a file matching `pathspec` (pathspec magic allowed). False outside a repository. */
export function isTrackedFile(workspaceRoot: string, pathspec: string): boolean {
  return checkTrackedFile(workspaceRoot, pathspec) === 'tracked';
}

/** Best-effort removal of a pinned checkpoint ref (e.g. if a persistent session fails to start). */
export function deleteCheckpointRef(workspaceRoot: string, taskId: string): void {
  tryRunGit(workspaceRoot, ['update-ref', '-d', `refs/ag-bridge/checkpoints/${taskId}`]);
}

export function getGitInfo(workspaceRoot: string): GitStatusInfo {
  // Single subprocess (`git status --porcelain=v1 -b`) reduces latency ~3x vs 3 separate git calls
  const statusRes = tryRunGit(workspaceRoot, ['status', '--porcelain=v1', '-b']);
  if (!statusRes.ok) {
    if (!statusRes.timedOut) return { isGitRepo: false };
    const ended = statusRes.leftoversEnded;
    const cleanup = ended > 0 ? ` (ended ${ended} process${ended === 1 ? '' : 'es'} it left running)` : '';
    return { isGitRepo: false, error: `Git did not answer within ${gitTimeoutMs()} ms${cleanup}` };
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
  // Windows and macOS file systems ignore case, but a repository brought from Linux can still say
  // core.ignorecase=false; git then lists a tracked file whose case changed as untracked, and the
  // rollback deleted it (Antigravity leg, measured; TC-S22c).
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  const res = tryRunGit(workspaceRoot, [
    ...(foldCase ? ['-c', 'core.ignorecase=true'] : []),
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ]);
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
  /** What HEAD named at the checkpoint: `refs/heads/<branch>`, or `HEAD` when detached. */
  headRef?: string;
  /** Workspace-relative folder holding a copy of the untracked files, when they fit the cap. */
  untrackedSnapshotDir?: string;
  warning?: string;
}

/** The manifest fields a checkpoint fills — one mapping for every caller that writes a manifest. */
export function checkpointManifestFields(
  cp: CheckpointResult,
): Pick<
  BridgeManifest,
  'gitCheckpointRef' | 'gitCheckpointIsStash' | 'gitUntrackedBaseline' | 'gitCheckpointHeadRef' | 'gitUntrackedSnapshotDir'
> {
  return {
    gitCheckpointRef: cp.checkpointRef,
    gitCheckpointIsStash: cp.isStashSnapshot,
    gitUntrackedBaseline: cp.untrackedBaseline,
    gitCheckpointHeadRef: cp.headRef,
    gitUntrackedSnapshotDir: cp.untrackedSnapshotDir,
  };
}

/*
 * Rollback recovery (ARC-003 §5.5). Three reviewers settled it over two rounds: what rollback removes
 * is moved under .ag-bridge/recovery/<taskId>/ instead of deleted, the user's untracked files are
 * copied aside at the checkpoint when they fit a cap, and the state before reverting is recorded.
 * Measured on Windows NVMe: copying 2,000 files of 25 KB took 2.5 s (git objects: 18.6 s); 20,000
 * small files took 20 s to copy, hence the cap.
 */
const SNAPSHOT_MAX_FILES = 2_000;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;

export interface RecoveryRetention {
  maxTasks: number;
  maxAgeMs: number;
  maxBytes: number;
}

/** Kept: the last 10 tasks or 7 days, whichever is fewer, and no more than 250 MB in all. */
export const RECOVERY_RETENTION: RecoveryRetention = {
  maxTasks: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 250 * 1024 * 1024,
};

const recoveryRoot = (workspaceRoot: string): string => path.join(getBridgeDir(workspaceRoot), 'recovery');
const relativeTo = (workspaceRoot: string, abs: string): string =>
  path.relative(workspaceRoot, abs).split(path.sep).join('/');
const snapshotDirFor = (workspaceRoot: string, taskId: string): string =>
  path.join(recoveryRoot(workspaceRoot), assertSafeTaskId(taskId), 'untracked');

/** Copy the user's untracked files aside; over the cap (or on any copy error) nothing is kept and a warning says so. */
function snapshotUntracked(
  workspaceRoot: string,
  taskId: string,
  baseline: string[],
): { dir?: string; warning?: string } {
  const files: string[] = [];
  let bytes = 0;
  for (const rel of baseline) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(workspaceRoot, rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // a link or a nested repository is left alone
    files.push(rel);
    bytes += st.size;
  }
  if (files.length > SNAPSHOT_MAX_FILES || bytes > SNAPSHOT_MAX_BYTES) {
    return {
      warning:
        `The ${files.length} untracked files (${(bytes / 1024 / 1024).toFixed(1)} MB) were not snapshotted: they exceed ` +
        `the ${SNAPSHOT_MAX_FILES}-file / ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB cap, so a rollback cannot undo an agent's edit or delete of one.`,
    };
  }
  if (files.length === 0) return {};
  const dir = snapshotDirFor(workspaceRoot, taskId);
  try {
    for (const rel of files) {
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(workspaceRoot, rel), dst);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const why = err instanceof Error ? err.message : String(err);
    return { warning: `The untracked files were not snapshotted (${why}), so a rollback cannot undo an agent's edit or delete of one.` };
  }
  return { dir: relativeTo(workspaceRoot, dir) };
}

/**
 * Make every folder on the way to `rel` a real folder inside the workspace: a link the agent put in
 * place of one (a junction out of the workspace) is moved aside first, so nothing is written or
 * moved through it (TC-S24f).
 */
function realFoldersTo(workspaceRoot: string, rel: string, moveAside: (rel: string) => void): void {
  const parts = rel.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const partRel = parts.slice(0, i).join('/');
    const abs = path.join(workspaceRoot, partRel);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = undefined;
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) moveAside(partRel);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) fs.mkdirSync(abs);
  }
}

/** Whether a folder on the way to `rel` (not `rel` itself) is a link — a symlink or a junction. */
function linkOnTheWay(workspaceRoot: string, rel: string): boolean {
  const parts = rel.split('/').filter((p) => p.length > 0).slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (fs.lstatSync(path.join(workspaceRoot, parts.slice(0, i).join('/'))).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Files under `dir`, as `/`-separated paths relative to it; links are skipped. */
function regularFilesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...regularFilesUnder(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function bytesUnder(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += bytesUnder(abs);
    else if (entry.isFile()) total += fs.statSync(abs).size;
  }
  return total;
}

/**
 * Delete the recovery folders (and pre-rollback refs) of tasks beyond the retention policy: the
 * newest `maxTasks` that are younger than `maxAgeMs` are kept, then the oldest are dropped until the
 * total fits `maxBytes`. The task at hand is always kept. Returns the task ids pruned.
 */
export function pruneRecoveryArtifacts(
  workspaceRoot: string,
  keepTaskId?: string,
  policy: RecoveryRetention = RECOVERY_RETENTION,
  now: number = Date.now(),
): string[] {
  const root = recoveryRoot(workspaceRoot);
  let entries: Array<{ id: string; mtimeMs: number; bytes: number }>;
  try {
    entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(root, e.name);
        return { id: e.name, mtimeMs: fs.statSync(dir).mtimeMs, bytes: bytesUnder(dir) };
      });
  } catch {
    return [];
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = entries.filter((e) => e.id === keepTaskId);
  const pruned: string[] = [];
  for (const e of entries) {
    if (e.id === keepTaskId) continue;
    if (kept.length < policy.maxTasks && now - e.mtimeMs <= policy.maxAgeMs) kept.push(e);
    else pruned.push(e.id);
  }
  let total = kept.reduce((sum, e) => sum + e.bytes, 0);
  while (total > policy.maxBytes) {
    const oldest = [...kept].reverse().find((e) => e.id !== keepTaskId);
    if (!oldest) break;
    kept.splice(kept.indexOf(oldest), 1);
    total -= oldest.bytes;
    pruned.push(oldest.id);
  }
  for (const id of pruned) {
    fs.rmSync(path.join(root, id), { recursive: true, force: true });
    tryRunGit(workspaceRoot, ['update-ref', '-d', `refs/ag-bridge/pre-rollback/${id}`]);
  }
  return pruned;
}

function symbolicHead(workspaceRoot: string): string | undefined {
  const res = tryRunGit(workspaceRoot, ['rev-parse', '--symbolic-full-name', 'HEAD']);
  return res.ok ? res.stdout.trim() : undefined;
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
  const headRef = symbolicHead(workspaceRoot);
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
  }

  const snapshot = snapshotUntracked(workspaceRoot, taskId, untrackedBaseline);
  pruneRecoveryArtifacts(workspaceRoot, taskId);
  return {
    checkpointRef: stashHash || headRes.stdout.trim(),
    isStashSnapshot: Boolean(stashHash),
    untrackedBaseline,
    headRef,
    untrackedSnapshotDir: snapshot.dir,
    ...(snapshot.warning ? { warning: snapshot.warning } : {}),
  };
}

export interface RollbackResult {
  restoredCheckpointRef: string;
  revertedTrackedFiles: string[];
  removedUntrackedFiles: string[];
  /** The checkpoint recorded no untracked baseline, so no untracked file was removed. */
  untrackedBaselineMissing: boolean;
  /** The user's untracked files put back from the checkpoint's snapshot. */
  restoredUntrackedFiles: string[];
  /** The checkpoint copied the untracked files, but that copy is gone (retention), so none was put back. */
  untrackedSnapshotMissing: boolean;
  /** Untracked paths left alone because a link (a junction) lies on the way to them. */
  pathsBehindLinks: string[];
  /** Where this rollback moved what it removed or replaced (workspace-relative), when it moved anything. */
  quarantineDir?: string;
  /** The commit HEAD was on before the rollback. */
  preRollbackHead: string;
  /** A ref holding the uncommitted tracked changes the rollback undid, when there were any. */
  preRollbackRef?: string;
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
    const why = gitInfo.error ?? 'Workspace is not a Git repository';
    throw new AgPluginError(
      'ROLLBACK_NO_CHECKPOINT',
      `${why}; cannot perform Git rollback.`,
    );
  }

  const ref = manifest.gitCheckpointRef;

  // reset --hard moves whichever branch is checked out: after the agent switched to the user's
  // dev, it moved dev onto main's commit (measured; TC-S23d). Refuse before changing anything.
  const recordedHead = manifest.gitCheckpointHeadRef;
  if (recordedHead !== undefined) {
    const headNow = symbolicHead(workspaceRoot) ?? '(unknown)';
    if (headNow !== recordedHead) {
      const wayBack = recordedHead.startsWith('refs/heads/')
        ? `run \`git switch ${recordedHead.slice('refs/heads/'.length)}\``
        : 'check out the commit it was taken on';
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `HEAD is on ${headNow}, but the checkpoint was taken on ${recordedHead}. Nothing was changed: ${wayBack}, then roll back again.`,
      );
    }
  }

  // Record the state before reverting, so the rollback itself can be undone (TC-S24e): the commit
  // HEAD is on, and — when there are uncommitted tracked changes — a `stash create` of them.
  const taskId = assertSafeTaskId(manifest.taskId);
  const preHeadRes = tryRunGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  const preStashRes = tryRunGit(workspaceRoot, ['stash', 'create', `ag-bridge-pre-rollback-${taskId}`]);
  if (!preHeadRes.ok || !preStashRes.ok) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      `Could not record the state before rollback; nothing was changed: ${preHeadRes.stderr || preStashRes.stderr}`,
    );
  }
  const preRollbackHead = preHeadRes.stdout.trim();
  let preRollbackRef: string | undefined;
  if (preStashRes.stdout.trim()) {
    preRollbackRef = `refs/ag-bridge/pre-rollback/${taskId}`;
    const pinRes = tryRunGit(workspaceRoot, ['update-ref', preRollbackRef, preStashRes.stdout.trim()]);
    if (!pinRes.ok) {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `Could not record the state before rollback; nothing was changed: ${pinRes.stderr}`,
      );
    }
  }

  // What rollback takes out of the work tree is moved under .ag-bridge/recovery/<taskId>/rollback-<time>/
  // — `removed/` for the agent's files, `replaced/` for its versions of the user's — never deleted (TC-S24).
  let runDir: string | undefined;
  const moveAside = (rel: string, kind: 'removed' | 'replaced'): void => {
    runDir ??= path.join(recoveryRoot(workspaceRoot), taskId, `rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const dst = path.join(runDir, kind, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const src = path.join(workspaceRoot, rel);
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  };

  // With no baseline (an older manifest, or one written by hand) nothing tells the user's
  // untracked files from the agent's: keep all (TC-S22).
  const baseline = manifest.gitUntrackedBaseline;
  const untrackedBaselineMissing = baseline === undefined;
  const baselineSet = new Set(baseline ?? []);

  // Everything now in the index that the checkpoint does not have leaves the index first:
  // - the user's untracked files the agent staged or committed (`git add -A`) — reset --hard deleted
  //   them (Grok leg, measured; TC-S23, TC-S23b);
  // - the files the agent created and staged or committed — reset --hard deleted them for good;
  //   left in the work tree, they go to the recovery folder with the rest (TC-S24b).
  const addedRes = tryRunGit(workspaceRoot, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=A', ref]);
  if (!addedRes.ok) {
    throw new AgPluginError('GIT_CHECKPOINT_FAILED', `Failed to read the index before rollback: ${addedRes.stderr}`);
  }
  const addedSinceCheckpoint = addedRes.stdout.split('\0').filter((file) => file.length > 0 && !isBridgePath(file));
  if (addedSinceCheckpoint.length > 0) {
    const unstageRes = tryRunGit(
      workspaceRoot,
      ['update-index', '-z', '--force-remove', '--stdin'],
      addedSinceCheckpoint.join('\0'),
    );
    if (!unstageRes.ok) {
      throw new AgPluginError(
        'GIT_CHECKPOINT_FAILED',
        `Failed to unstage the files added since the checkpoint: ${unstageRes.stderr}`,
      );
    }
  }

  // A file at a path the agent removed from git (`git rm`) and then wrote again is untracked now;
  // reset --hard overwrote it with the checkpoint's version and kept no copy (Antigravity review,
  // measured; TC-S24i). Move it aside first; reset then writes the checkpoint's file.
  const removedFromIndexRes = tryRunGit(workspaceRoot, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=D', ref]);
  if (!removedFromIndexRes.ok) {
    throw new AgPluginError('GIT_CHECKPOINT_FAILED', `Failed to read the index before rollback: ${removedFromIndexRes.stderr}`);
  }
  for (const rel of removedFromIndexRes.stdout.split('\0')) {
    if (rel.length === 0 || isBridgePath(rel) || linkOnTheWay(workspaceRoot, rel)) continue;
    let present = true;
    try {
      fs.lstatSync(path.join(workspaceRoot, rel));
    } catch {
      present = false;
    }
    if (present) moveAside(rel, 'replaced');
  }

  // What the rollback reverts: every tracked path that differs from the checkpoint, the agent's
  // commits included. `git status` named the user's untouched untracked files instead (TC-U36).
  const diffRes = tryRunGit(workspaceRoot, ['diff', '--name-only', '-z', '--no-renames', ref]);
  if (!diffRes.ok) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      `Failed to compare the work tree with checkpoint ${ref}: ${diffRes.stderr}`,
    );
  }
  const revertedTrackedFiles = diffRes.stdout
    .split('\0')
    .filter((file) => file.length > 0 && !isBridgePath(file))
    .sort();

  if (manifest.gitCheckpointIsStash) {
    // Back to the commit the snapshot was taken on (its first parent), so it applies without a
    // merge even after the agent committed (TC-S23c). An older manifest has no recorded branch to
    // check, so it keeps resetting to the current HEAD.
    const snapshotBase = recordedHead !== undefined ? `${ref}^1` : 'HEAD';
    const resetRes = tryRunGit(workspaceRoot, ['reset', '--hard', snapshotBase]);
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

  // Only untracked files created after delegation began. A failed listing removes nothing. Nothing
  // behind a link is touched: Windows git lists the files inside a junction's target, and rollback
  // moved them out of the outside folder — main deleted them (Antigravity review, measured; TC-S24h).
  const removedUntrackedFiles: string[] = [];
  const pathsBehindLinks: string[] = [];
  if (!untrackedBaselineMissing) {
    for (const relFile of listUntrackedFiles(workspaceRoot) ?? []) {
      if (baselineSet.has(relFile)) continue;
      if (linkOnTheWay(workspaceRoot, relFile)) {
        pathsBehindLinks.push(relFile);
        continue;
      }
      let present = true;
      try {
        fs.lstatSync(path.join(workspaceRoot, relFile));
      } catch {
        present = false;
      }
      if (present) {
        moveAside(relFile, 'removed');
        removedUntrackedFiles.push(relFile);
      }
    }
  }

  // The user's untracked files the agent edited or deleted come back from the snapshot; the agent's
  // version goes to `replaced/`. Only this task's own snapshot folder is read — the manifest is data
  // the agent could rewrite — and every folder on the way is made a real folder first (TC-S24c, f).
  const restoredUntrackedFiles: string[] = [];
  const snapshotDir = snapshotDirFor(workspaceRoot, taskId);
  const snapshotRecorded = manifest.gitUntrackedSnapshotDir === relativeTo(workspaceRoot, snapshotDir);
  // retention may already have removed it (TC-S24j): say so rather than restore nothing silently
  const untrackedSnapshotMissing = snapshotRecorded && !fs.existsSync(snapshotDir);
  if (snapshotRecorded && !untrackedSnapshotMissing) {
    for (const rel of regularFilesUnder(snapshotDir)) {
      const saved = path.join(snapshotDir, rel);
      const current = path.join(workspaceRoot, rel);
      realFoldersTo(workspaceRoot, rel, (partRel) => moveAside(partRel, 'replaced'));
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(current);
      } catch {
        st = undefined;
      }
      if (st?.isFile() && fs.readFileSync(current).equals(fs.readFileSync(saved))) continue;
      if (st) moveAside(rel, 'replaced');
      fs.copyFileSync(saved, current);
      restoredUntrackedFiles.push(rel);
    }
    restoredUntrackedFiles.sort();
  }

  // Clean up pinned ref if present
  tryRunGit(workspaceRoot, ['update-ref', '-d', `refs/ag-bridge/checkpoints/${manifest.taskId}`]);
  pruneRecoveryArtifacts(workspaceRoot, taskId);

  return {
    restoredCheckpointRef: ref,
    revertedTrackedFiles,
    removedUntrackedFiles,
    untrackedBaselineMissing,
    restoredUntrackedFiles,
    untrackedSnapshotMissing,
    pathsBehindLinks: pathsBehindLinks.sort(),
    ...(runDir ? { quarantineDir: relativeTo(workspaceRoot, runDir) } : {}),
    preRollbackHead,
    ...(preRollbackRef ? { preRollbackRef } : {}),
  };
}

export const WORKTREE_BRANCH_PREFIX = 'ag-task/';

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  branchDeleted: boolean;
  warning?: string;
}

const worktreesRoot = (workspaceRoot: string): string => path.join(getBridgeDir(workspaceRoot), 'worktrees');

function normalizeForContainment(p: string): string {
  const resolved = path.resolve(p);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // Path may not exist yet; keep resolved form
  }
  return process.platform === 'win32' || process.platform === 'darwin'
    ? canonical.toLowerCase()
    : canonical;
}

function isStrictlyInside(parentDir: string, candidatePath: string): boolean {
  const parent = normalizeForContainment(parentDir);
  const candidate = normalizeForContainment(candidatePath);
  const rel = path.relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Create an isolated linked git worktree under `.ag-bridge/worktrees/<taskId>` on a dedicated
 * `ag-task/<taskId>` branch created from `HEAD`. Because `.ag-bridge/` is excluded via
 * `.git/info/exclude`, the parent work tree stays clean and multiple worktree tasks can run
 * concurrently without `BRIDGE_BUSY` lock contention (ARC-003 §5.6, TC-U45).
 */
export function createTaskWorktree(workspaceRoot: string, taskId: string): WorktreeInfo {
  const safeId = assertSafeTaskId(taskId);
  const info = getGitInfo(workspaceRoot);
  if (!info.isGitRepo) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      info.error
        ? `Cannot create isolated worktree: ${info.error}`
        : 'Git worktree isolation (`isolateWorktree: true`) requires a Git repository.',
    );
  }

  const headRes = tryRunGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!headRes.ok || !headRes.stdout.trim()) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      'Cannot create isolated worktree: repository has no commits yet (HEAD does not exist).',
    );
  }
  const baseCommit = headRes.stdout.trim();

  const wtRoot = worktreesRoot(workspaceRoot);
  fs.mkdirSync(wtRoot, { recursive: true });
  const worktreePath = path.join(wtRoot, safeId);
  const branchName = `${WORKTREE_BRANCH_PREFIX}${safeId}`;

  const addRes = tryRunGit(workspaceRoot, ['worktree', 'add', '-b', branchName, worktreePath, baseCommit]);
  if (!addRes.ok) {
    throw new AgPluginError(
      'GIT_CHECKPOINT_FAILED',
      `Failed to create isolated git worktree at ${worktreePath}: ${addRes.stderr}`,
    );
  }

  return {
    worktreePath,
    branchName,
    baseCommit,
  };
}

/**
 * Safely remove a previously created task worktree and optionally delete its `ag-task/<taskId>`
 * branch. Refuses paths outside `.ag-bridge/worktrees/` or symlink escapes, and never deletes
 * branches outside the `ag-task/` namespace (TC-S27).
 */
export function removeTaskWorktree(
  workspaceRoot: string,
  worktreePath: string,
  branchName?: string,
  deleteBranch = true,
): WorktreeRemoveResult {
  const wtRoot = worktreesRoot(workspaceRoot);
  const resolvedTarget = path.resolve(worktreePath);

  // Guard against symlinked .ag-bridge/worktrees or symlinked target directory
  try {
    if (fs.lstatSync(wtRoot).isSymbolicLink()) {
      throw new AgPluginError(
        'PATH_TRAVERSAL_BLOCKED',
        'Refusing to remove worktree: .ag-bridge/worktrees is a symbolic link.',
      );
    }
  } catch (err) {
    if (err instanceof AgPluginError) throw err;
  }
  try {
    if (fs.lstatSync(resolvedTarget).isSymbolicLink()) {
      throw new AgPluginError(
        'PATH_TRAVERSAL_BLOCKED',
        `Refusing to remove worktree: target "${worktreePath}" is a symbolic link.`,
      );
    }
  } catch (err) {
    if (err instanceof AgPluginError) throw err;
  }

  if (!isStrictlyInside(wtRoot, resolvedTarget)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Refusing to remove worktree outside .ag-bridge/worktrees/: "${worktreePath}".`,
    );
  }

  const warnings: string[] = [];
  let removed = false;

  const removeRes = tryRunGit(workspaceRoot, ['worktree', 'remove', '--force', resolvedTarget]);
  if (removeRes.ok) {
    removed = true;
  } else {
    // Worktree folder might already be gone or partially removed: prune metadata and remove folder
    tryRunGit(workspaceRoot, ['worktree', 'prune']);
    if (fs.existsSync(resolvedTarget)) {
      try {
        fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        tryRunGit(workspaceRoot, ['worktree', 'prune']);
        removed = !fs.existsSync(resolvedTarget);
      } catch (err) {
        warnings.push(
          `Could not fully remove worktree directory (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    } else {
      removed = true;
    }
  }

  let branchDeleted = false;
  if (deleteBranch && branchName) {
    if (!branchName.startsWith(WORKTREE_BRANCH_PREFIX)) {
      warnings.push(
        `Refused to delete branch "${branchName}": only branches under "${WORKTREE_BRANCH_PREFIX}" may be deleted automatically.`,
      );
    } else {
      const delRes = tryRunGit(workspaceRoot, ['branch', '-D', branchName]);
      if (delRes.ok) {
        branchDeleted = true;
      } else {
        warnings.push(`Could not delete branch "${branchName}": ${delRes.stderr.trim() || 'unknown error'}`);
      }
    }
  }

  return {
    removed,
    branchDeleted,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  };
}
