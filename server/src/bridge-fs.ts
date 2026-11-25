import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgPluginError,
  BridgeConfig,
  BridgeManifest,
  DEFAULT_BRIDGE_CONFIG,
  TEMPLATE_VERSION,
} from './types.js';

export const BRIDGE_DIR_NAME = '.ag-bridge';
const MAX_HISTORY_ITEMS = 20;
const SAFE_TASK_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function assertSafeTaskId(taskId: string): string {
  const trimmed = taskId.trim();
  if (
    !trimmed ||
    !SAFE_TASK_ID_RE.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('..') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.toLowerCase().endsWith('.lock') ||
    WINDOWS_RESERVED_DEVICE_RE.test(trimmed)
  ) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Invalid taskId "${taskId}": must match ${SAFE_TASK_ID_RE.source} without path traversal, leading/trailing dots, .lock suffix, or reserved device names.`,
    );
  }
  return trimmed;
}

export function getBridgeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, BRIDGE_DIR_NAME);
}

export function getManifestPath(workspaceRoot: string): string {
  return path.join(getBridgeDir(workspaceRoot), 'manifest.json');
}

export function getDispatchPath(workspaceRoot: string): string {
  return path.join(getBridgeDir(workspaceRoot), 'dispatch.md');
}

export function getReportPath(workspaceRoot: string): string {
  return path.join(getBridgeDir(workspaceRoot), 'report.md');
}

export function getArtifactsDir(workspaceRoot: string, taskId?: string): string {
  const base = path.join(getBridgeDir(workspaceRoot), 'artifacts');
  return taskId ? path.join(base, assertSafeTaskId(taskId)) : base;
}

export function getHistoryDir(workspaceRoot: string): string {
  return path.join(getBridgeDir(workspaceRoot), 'history');
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short bounded busy-wait for Windows transient EBUSY/EPERM rename retries
  }
}

export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );

  fs.writeFileSync(tmpPath, content, 'utf8');

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  try {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch {
    // ignore cleanup error
  }
  throw lastErr;
}

export function readJsonWithRetry<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      lastErr = err;
      if (attempt < 2) {
        sleepSync(50 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export function hasSymlinkInChain(baseDir: string, relSegments: string[]): boolean {
  let cursor = path.resolve(baseDir);
  for (const seg of relSegments) {
    cursor = path.join(cursor, seg);
    const st = lstatOrNull(cursor);
    if (!st) {
      return false;
    }
    if (st.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export function assertNoSymlinkChain(baseDir: string, relSegments: string[], label?: string): void {
  if (hasSymlinkInChain(baseDir, relSegments)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Refusing to traverse symbolic link at ${label ?? relSegments.join('/')}.`,
    );
  }
}

export function ensureBridgeDirs(workspaceRoot: string): void {
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME], '.ag-bridge');
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, 'artifacts'], '.ag-bridge/artifacts');
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, 'history'], '.ag-bridge/history');
  fs.mkdirSync(getBridgeDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getArtifactsDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getHistoryDir(workspaceRoot), { recursive: true });
}

/**
 * Which file keeps `.ag-bridge/` out of git (ADR-005). Inside a git work tree it is the
 * repository's local `.git/info/exclude`, so the plugin never edits a tracked file in the
 * user's project; outside one there is nothing tracked to dirty, so `.gitignore` is used.
 */
export type IgnoreFile = 'git-info-exclude' | 'gitignore';

export const GIT_EXCLUDE_HEADER =
  '# antigravity-delegate: local session artifacts (kept out of the tracked .gitignore)';
/** `.ag-bridge/` matches at any depth; the template paths need `**\/` because they contain a slash. */
export const GIT_EXCLUDE_PATTERNS: readonly string[] = [
  `${BRIDGE_DIR_NAME}/`,
  '**/.agent/workflows/claude-handoff.md',
  '**/.agents/workflows/claude-handoff.md',
];

function readTrimmedLines(file: string): string[] {
  const st = lstatOrNull(file);
  if (!st || !st.isFile()) {
    return [];
  }
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

function hasBridgeEntry(lines: string[]): boolean {
  return lines.some((line) => line === '.ag-bridge' || line === '.ag-bridge/' || line === '/.ag-bridge/');
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** A real (non-linked) directory that holds a real HEAD file — what git itself would accept as a git dir. */
function isGitDir(dir: string): boolean {
  return (
    Boolean(lstatOrNull(dir)?.isDirectory()) &&
    Boolean(lstatOrNull(path.join(dir, 'HEAD'))?.isFile())
  );
}

/** Verify no intermediate path segment between `rootDir` and `targetDir` is a symlink when inside `rootDir`. */
function hasRelativeSymlinkEscape(rootDir: string, rawRelative: string): boolean {
  if (path.isAbsolute(rawRelative)) {
    return false;
  }
  const normalized = path.normalize(rawRelative);
  const parts = normalized.split(path.sep).filter((p) => p.length > 0 && p !== '.');
  let cursor = path.resolve(rootDir);
  for (const part of parts) {
    if (part === '..') {
      cursor = path.dirname(cursor);
      continue;
    }
    cursor = path.join(cursor, part);
    if (lstatOrNull(cursor)?.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

/** `.git` file (linked worktree, submodule) → the common git dir that owns `info/`. */
function commonDirFromGitFile(dotGitFile: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(dotGitFile, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!match) {
    return null;
  }
  const rawGitDir = match[1];
  const baseDir = path.dirname(dotGitFile);
  if (hasRelativeSymlinkEscape(baseDir, rawGitDir)) {
    return null;
  }
  const gitDir = path.resolve(baseDir, rawGitDir);
  if (!isGitDir(gitDir)) {
    return null;
  }
  const commondirFile = path.join(gitDir, 'commondir');
  const commondirStat = lstatOrNull(commondirFile);
  if (!commondirStat) {
    return gitDir;
  }
  if (!commondirStat.isFile()) {
    return null;
  }
  let rawCommon: string;
  try {
    rawCommon = fs.readFileSync(commondirFile, 'utf8').trim();
  } catch {
    return null;
  }
  if (hasRelativeSymlinkEscape(gitDir, rawCommon)) {
    return null;
  }
  const commonDir = path.resolve(gitDir, rawCommon);
  return isGitDir(commonDir) ? commonDir : null;
}

function findEnclosingDotGit(workspaceRoot: string): { dotGit: string; stat: fs.Stats } | null {
  const caseFold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => caseFold(path.resolve(dir)));

  for (let dir = path.resolve(workspaceRoot); ; ) {
    const dotGit = path.join(dir, '.git');
    const stat = lstatOrNull(dotGit);
    if (stat) {
      return { dotGit, stat };
    }
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.includes(caseFold(parent))) {
      return null;
    }
    dir = parent;
  }
}

/**
 * True when a `.git` entry (directory, file, or symlink) encloses `workspaceRoot` or `GIT_DIR` is set.
 * Used by config-trust fail-closed checks (ARC-003 §7) so symlinked `.git/info/exclude` can never
 * cause `config.ts` to treat a git repo as a non-repo.
 */
export function hasAnyDotGitEntry(workspaceRoot: string): boolean {
  if (process.env.GIT_DIR && process.env.GIT_DIR.trim().length > 0) {
    return true;
  }
  return findEnclosingDotGit(workspaceRoot) !== null;
}

/**
 * True when `workspaceRoot` is inside a real git work tree (valid `.git` dir or valid `gitdir:` file),
 * even if `.git/info` or `.git/info/exclude` is symlinked/unwritable.
 */
function isRealGitWorkTree(workspaceRoot: string): boolean {
  const found = findEnclosingDotGit(workspaceRoot);
  if (!found) return false;
  if (found.stat.isDirectory()) return isGitDir(found.dotGit);
  if (found.stat.isFile()) return commonDirFromGitFile(found.dotGit) !== null;
  return false;
}

/**
 * Absolute path of the repository's `info/exclude` for a workspace, or null when the workspace
 * is not inside a git work tree or that file is not safe to write (ADR-005).
 */
export function resolveGitExcludePath(workspaceRoot: string): string | null {
  const found = findEnclosingDotGit(workspaceRoot);
  let commonDir: string | null = null;
  if (found) {
    if (found.stat.isDirectory()) {
      commonDir = isGitDir(found.dotGit) ? found.dotGit : null;
    } else if (found.stat.isFile()) {
      commonDir = commonDirFromGitFile(found.dotGit);
    }
  }
  if (!commonDir) {
    return null;
  }

  const infoDir = path.join(commonDir, 'info');
  const infoStat = lstatOrNull(infoDir);
  if (infoStat && !infoStat.isDirectory()) {
    return null;
  }
  const excludePath = path.join(infoDir, 'exclude');
  const excludeStat = lstatOrNull(excludePath);
  if (excludeStat && !excludeStat.isFile()) {
    return null;
  }
  return excludePath;
}

/** True when git ignores `.ag-bridge/` through `.gitignore` or the repository's `info/exclude`. */
export function isGitignoreProtected(workspaceRoot: string): boolean {
  if (hasBridgeEntry(readTrimmedLines(path.join(workspaceRoot, '.gitignore')))) {
    return true;
  }
  const excludePath = resolveGitExcludePath(workspaceRoot);
  return excludePath !== null && hasBridgeEntry(readTrimmedLines(excludePath));
}

export function ensureGitignoreEntry(workspaceRoot: string): {
  updated: boolean;
  protected: boolean;
  file: IgnoreFile;
} {
  const excludePath = resolveGitExcludePath(workspaceRoot);
  if (excludePath) {
    const lines = readTrimmedLines(excludePath);
    const missing = GIT_EXCLUDE_PATTERNS.filter((pattern) => !lines.includes(pattern));
    if (missing.length === 0) {
      return { updated: false, protected: true, file: 'git-info-exclude' };
    }
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    const header = lines.includes(GIT_EXCLUDE_HEADER) ? [] : [GIT_EXCLUDE_HEADER];
    fs.appendFileSync(excludePath, `${separator}${[...header, ...missing].join('\n')}\n`, 'utf8');
    return { updated: true, protected: true, file: 'git-info-exclude' };
  }

  // Inside a real git work tree whose `.git/info` or `.git/info/exclude` is symlinked/unsafe:
  // never fall back to mutating the repository's tracked `.gitignore` (ADR-005).
  if (isRealGitWorkTree(workspaceRoot)) {
    return { updated: false, protected: false, file: 'git-info-exclude' };
  }

  // Not a git work tree: there is no tracked file to dirty, so keep the historical behaviour.
  if (isGitignoreProtected(workspaceRoot)) {
    return { updated: false, protected: true, file: 'gitignore' };
  }

  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const block = '# Antigravity Claude Bridge (local session artifacts)\n.ag-bridge/\n';

  const gitignoreStat = lstatOrNull(gitignorePath);
  if (gitignoreStat && !gitignoreStat.isFile()) {
    // Never append through a symlink the workspace controls; report the bridge as unprotected.
    return { updated: false, protected: false, file: 'gitignore' };
  }

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, block, 'utf8');
    return { updated: true, protected: true, file: 'gitignore' };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsLeadingNewline ? '\n\n' : existing.length > 0 ? '\n' : ''}${block}`;
  fs.appendFileSync(gitignorePath, addition, 'utf8');
  return { updated: true, protected: true, file: 'gitignore' };
}

export function ensureDefaultConfig(workspaceRoot: string): { created: boolean; path: string } {
  ensureBridgeDirs(workspaceRoot);
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, 'config.json'], '.ag-bridge/config.json');
  const configPath = path.join(getBridgeDir(workspaceRoot), 'config.json');
  if (fs.existsSync(configPath)) {
    return { created: false, path: configPath };
  }
  const initialConfig: BridgeConfig = {
    execution_mode: DEFAULT_BRIDGE_CONFIG.execution_mode,
    git_guard: DEFAULT_BRIDGE_CONFIG.git_guard,
    subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription },
    api: { ...DEFAULT_BRIDGE_CONFIG.api },
  };
  atomicWriteFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
  return { created: true, path: configPath };
}

export function readManifest(workspaceRoot: string): BridgeManifest | null {
  return readJsonWithRetry<BridgeManifest>(getManifestPath(workspaceRoot));
}

export function writeManifest(workspaceRoot: string, manifest: BridgeManifest): void {
  ensureBridgeDirs(workspaceRoot);
  atomicWriteFile(getManifestPath(workspaceRoot), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function archiveManifest(workspaceRoot: string, manifest: BridgeManifest): void {
  ensureBridgeDirs(workspaceRoot);
  const safeId = assertSafeTaskId(manifest.taskId);
  const historyDir = getHistoryDir(workspaceRoot);
  const archivePath = path.join(historyDir, `${safeId}.json`);
  atomicWriteFile(archivePath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Prune old history files beyond MAX_HISTORY_ITEMS (skip broken symlinks / concurrently deleted files)
  const files: Array<{ name: string; mtime: number }> = [];
  for (const f of fs.readdirSync(historyDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const st = fs.lstatSync(path.join(historyDir, f));
      if (!st.isFile()) continue;
      files.push({ name: f, mtime: st.mtimeMs });
    } catch {
      // ignore broken symlink or concurrently removed entry
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const excess of files.slice(MAX_HISTORY_ITEMS)) {
    try {
      fs.unlinkSync(path.join(historyDir, excess.name));
    } catch {
      // ignore prune error
    }
  }
}

export function readArchivedManifest(workspaceRoot: string, taskId: string): BridgeManifest | null {
  const safeId = assertSafeTaskId(taskId);
  const archivePath = path.join(getHistoryDir(workspaceRoot), `${safeId}.json`);
  return readJsonWithRetry<BridgeManifest>(archivePath);
}

export function readAllTaskManifests(workspaceRoot: string): BridgeManifest[] {
  const byId = new Map<string, BridgeManifest>();

  const historyDir = getHistoryDir(workspaceRoot);
  if (fs.existsSync(historyDir)) {
    for (const entry of fs.readdirSync(historyDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const m = readJsonWithRetry<BridgeManifest>(path.join(historyDir, entry));
        if (m?.taskId) {
          byId.set(m.taskId, m);
        }
      } catch {
        // skip corrupted archive file
      }
    }
  }

  try {
    const current = readManifest(workspaceRoot);
    if (current?.taskId) {
      byId.set(current.taskId, current);
    }
  } catch {
    // ignore transient error
  }

  return Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return tb - ta;
  });
}

export function getDispatchLockPath(workspaceRoot: string): string {
  return path.join(getBridgeDir(workspaceRoot), 'dispatch.lock');
}

export function releaseBridgeLock(workspaceRoot: string): void {
  try {
    fs.rmSync(getDispatchLockPath(workspaceRoot), { force: true });
  } catch {
    // ignore cleanup errors
  }
}

function acquireAtomicDispatchLockFile(workspaceRoot: string, timeoutSec: number, nowMs: number): void {
  ensureBridgeDirs(workspaceRoot);
  const lockPath = getDispatchLockPath(workspaceRoot);
  const payload = `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(nowMs).toISOString(), timeoutSec })}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, payload, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw err;
      }
      // Inspect existing lockfile to see whether it is stale
      let stale = false;
      try {
        const st = fs.lstatSync(lockPath);
        const raw = st.isFile() ? fs.readFileSync(lockPath, 'utf8') : '';
        let acquiredMs = st.mtimeMs;
        let lockTimeoutSec = Math.max(timeoutSec, 60);
        try {
          const parsed = JSON.parse(raw) as { acquiredAt?: string; timeoutSec?: number };
          const parsedMs = parsed.acquiredAt ? Date.parse(parsed.acquiredAt) : Number.NaN;
          if (!Number.isNaN(parsedMs)) acquiredMs = parsedMs;
          if (typeof parsed.timeoutSec === 'number' && parsed.timeoutSec > 0) {
            lockTimeoutSec = Math.max(parsed.timeoutSec, 60);
          }
        } catch {
          // corrupt lock file — treat as stale after 60s
        }
        const elapsedMs = Math.max(0, nowMs - acquiredMs);
        if (elapsedMs > lockTimeoutSec * 1000) {
          stale = true;
        }
      } catch {
        // Lock disappeared between openSync and lstatSync — retry once
        stale = true;
      }

      if (stale && attempt === 0) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // ignore
        }
        continue;
      }

      throw new AgPluginError(
        'BRIDGE_BUSY',
        'Another delegation is currently initializing a checkpoint/lock for this workspace. Retry shortly or inspect .ag-bridge/dispatch.lock.',
      );
    }
  }
}

export function acquireBridgeLock(
  workspaceRoot: string,
  timeoutSec: number,
  nowMs: number = Date.now(),
): { warnings: string[]; release: () => void } {
  const warnings: string[] = [];
  acquireAtomicDispatchLockFile(workspaceRoot, timeoutSec, nowMs);
  const release = (): void => releaseBridgeLock(workspaceRoot);

  try {
    let current: BridgeManifest | null = null;
    try {
      current = readManifest(workspaceRoot);
    } catch (err) {
      // Corrupt manifest.json must never permanently lock out the bridge: quarantine it safely.
      const manifestPath = getManifestPath(workspaceRoot);
      const quarantinePath = path.join(
        getBridgeDir(workspaceRoot),
        `manifest.corrupt-${nowMs}.json`,
      );
      try {
        if (fs.existsSync(manifestPath)) {
          fs.renameSync(manifestPath, quarantinePath);
        }
      } catch {
        try {
          fs.rmSync(manifestPath, { force: true });
        } catch {
          // ignore
        }
      }
      warnings.push(
        `Quarantined corrupted .ag-bridge/manifest.json (${err instanceof Error ? err.message : String(err)}) to recover bridge lock.`,
      );
      return { warnings, release };
    }

    if (!current) {
      return { warnings, release };
    }

    // Validate taskId safely so an agent-tampered taskId cannot lock out archival forever.
    let safeCurrentId: string | null = null;
    try {
      safeCurrentId = assertSafeTaskId(current.taskId);
    } catch {
      const manifestPath = getManifestPath(workspaceRoot);
      try {
        fs.renameSync(
          manifestPath,
          path.join(getBridgeDir(workspaceRoot), `manifest.invalid-id-${nowMs}.json`),
        );
      } catch {
        // ignore
      }
      warnings.push(
        `Quarantined manifest with invalid taskId "${String(current.taskId)}" to recover bridge lock.`,
      );
      return { warnings, release };
    }

    if (current.status === 'DISPATCHED' || current.status === 'RUNNING') {
      const updatedMs = Date.parse(current.updatedAt);
      const elapsedMs = Number.isNaN(updatedMs)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, nowMs - updatedMs);
      // Respect the active task's own recorded timeoutSec so a shorter-timeout caller cannot evict it.
      const activeTimeoutSec =
        typeof current.timeoutSec === 'number' && Number.isFinite(current.timeoutSec) && current.timeoutSec > 0
          ? current.timeoutSec
          : timeoutSec;
      if (elapsedMs <= activeTimeoutSec * 1000) {
        release();
        throw new AgPluginError(
          'BRIDGE_BUSY',
          `Another delegation task (${safeCurrentId}, status=${current.status}) is currently active (${Math.round(elapsedMs / 1000)}s elapsed). Wait for completion or inspect .ag-bridge/manifest.json.`,
          { activeTaskId: safeCurrentId, status: current.status },
        );
      }

      // Stale lock recovery: archive AND update manifest.json immediately so a subsequent failure won't re-archive it.
      const staleManifest: BridgeManifest = {
        ...current,
        taskId: safeCurrentId,
        status: 'FAILED',
        updatedAt: new Date(nowMs).toISOString(),
        errorCode: 'TASK_TIMEOUT',
        error: `Recovered stale task lock after ${Math.round(elapsedMs / 1000)}s without updates.`,
      };
      archiveManifest(workspaceRoot, staleManifest);
      writeManifest(workspaceRoot, staleManifest);
      warnings.push(
        `Recovered stale active task "${safeCurrentId}" (exceeded ${activeTimeoutSec}s timeout) and archived it to .ag-bridge/history/.`,
      );
      return { warnings, release };
    }

    if (current.status === 'VERIFIED' || current.status === 'FAILED') {
      archiveManifest(workspaceRoot, { ...current, taskId: safeCurrentId });
    }

    return { warnings, release };
  } catch (err) {
    release();
    throw err;
  }
}

export function generateTaskId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  const rand = crypto.randomBytes(2).toString('hex');
  return `ag-${y}${mo}${d}-${h}${mi}${s}-${rand}`;
}

export function writeDispatchMarkdown(
  workspaceRoot: string,
  params: {
    manifest: BridgeManifest;
    instructions: string;
    acceptanceCriteria: string[];
  },
): string {
  const { manifest, instructions, acceptanceCriteria } = params;
  const lockedList =
    manifest.lockedPaths.length > 0
      ? manifest.lockedPaths.map((p) => `- \`${p}\``).join('\n')
      : '- (general / read-only or unrestricted subscription delegation)';
  const criteriaList =
    acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] Complete the requested task and summarize results clearly';

  const content = [
    '# Antigravity Task Dispatch',
    '',
    `- **Task ID:** \`${manifest.taskId}\``,
    `- **Title:** ${manifest.title}`,
    `- **Mode:** \`${manifest.mode}\``,
    `- **Created At:** \`${manifest.createdAt}\``,
    `- **Verify URL:** ${manifest.verifyUrl ? `\`${manifest.verifyUrl}\`` : 'N/A'}`,
    '',
    '## Locked Paths (Allowed Write Scope — Strictly Enforced)',
    lockedList,
    '',
    '## Instructions & Context',
    instructions.trim(),
    '',
    '## Acceptance Criteria',
    criteriaList,
    '',
  ].join('\n');

  const dispatchPath = getDispatchPath(workspaceRoot);
  atomicWriteFile(dispatchPath, content);
  return dispatchPath;
}

const MAX_TAIL_READ_BYTES = 256 * 1024;

/**
 * Safely read the tail of a regular file (never following symlinks on any path component) up to
 * `maxBytes` so large logs cannot OOM the MCP server and planted symlinks cannot exfiltrate files.
 */
export function readSafeFileTail(
  workspaceRoot: string,
  relSegments: string[],
  maxBytes = MAX_TAIL_READ_BYTES,
): string | null {
  if (hasSymlinkInChain(workspaceRoot, relSegments)) {
    return null;
  }
  const fullPath = path.join(workspaceRoot, ...relSegments);
  const st = lstatOrNull(fullPath);
  if (!st || !st.isFile()) {
    return null;
  }
  try {
    if (st.size <= maxBytes) {
      return fs.readFileSync(fullPath, 'utf8');
    }
    const fd = fs.openSync(fullPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readReportMarkdown(workspaceRoot: string): string | null {
  if (hasSymlinkInChain(workspaceRoot, [BRIDGE_DIR_NAME, 'report.md'])) {
    return null;
  }
  const reportPath = getReportPath(workspaceRoot);
  const st = lstatOrNull(reportPath);
  if (!st || !st.isFile()) {
    return null;
  }
  return fs.readFileSync(reportPath, 'utf8');
}

export function writeReportMarkdown(workspaceRoot: string, content: string): string {
  const reportPath = getReportPath(workspaceRoot);
  atomicWriteFile(reportPath, content);
  return reportPath;
}

export function clearReportMarkdown(workspaceRoot: string): void {
  const reportPath = getReportPath(workspaceRoot);
  try {
    fs.rmSync(reportPath, { force: true });
  } catch {
    // ignore cleanup error if already absent
  }
}

export function listTaskArtifacts(workspaceRoot: string, taskId: string): string[] {
  const bridgeDir = getBridgeDir(workspaceRoot);
  const artifacts: string[] = [];

  const scanDir = (dirPath: string): void => {
    if (!fs.existsSync(dirPath)) {
      return;
    }
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.isFile()) {
        artifacts.push(path.relative(bridgeDir, full).split(path.sep).join('/'));
      }
    }
  };

  scanDir(getArtifactsDir(workspaceRoot, taskId));
  return artifacts.sort();
}

function extractTemplateVersion(content: string): string | null {
  const match = content.match(/<!--\s*ag-plugin-template-version:\s*([^\s>]+)\s*-->/);
  return match ? match[1] : null;
}

export function syncHandoffTemplate(
  workspaceRoot: string,
  pluginRoot: string,
  options: { force?: boolean } = {},
): { syncedPaths: string[]; skippedCustomPaths: string[] } {
  const templatePath = path.join(pluginRoot, 'templates', 'claude-handoff.md');
  if (!fs.existsSync(templatePath)) {
    return { syncedPaths: [], skippedCustomPaths: [] };
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  const templateVer = extractTemplateVersion(templateContent) ?? TEMPLATE_VERSION;

  const targetChains: string[][] = [['.agent', 'workflows', 'claude-handoff.md']];

  // ADR-003: Also mirror into .agents/workflows/ if the workspace already has a real `.agents/` directory
  const agentsStat = lstatOrNull(path.join(workspaceRoot, '.agents'));
  if (agentsStat?.isDirectory() && !agentsStat.isSymbolicLink()) {
    targetChains.push(['.agents', 'workflows', 'claude-handoff.md']);
  }

  const syncedPaths: string[] = [];
  const skippedCustomPaths: string[] = [];

  for (const chain of targetChains) {
    // TH-06: Never follow symlinks/junctions when syncing handoff templates (SessionStart hook runs automatically).
    if (hasSymlinkInChain(workspaceRoot, chain)) {
      continue;
    }
    const target = path.join(workspaceRoot, ...chain);
    const targetStat = lstatOrNull(target);
    if (!targetStat) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
      continue;
    }
    if (!targetStat.isFile()) {
      continue;
    }

    const existing = fs.readFileSync(target, 'utf8');
    const existingVer = extractTemplateVersion(existing);

    if (options.force) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
      continue;
    }

    if (!existingVer) {
      // User customized file without plugin version marker; preserve it
      skippedCustomPaths.push(target);
      continue;
    }

    if (existingVer !== templateVer) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
    }
  }

  return { syncedPaths, skippedCustomPaths };
}
