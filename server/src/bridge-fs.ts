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

export function assertSafeTaskId(taskId: string): string {
  const trimmed = taskId.trim();
  if (
    !trimmed ||
    !SAFE_TASK_ID_RE.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('..')
  ) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Invalid taskId "${taskId}": must match ${SAFE_TASK_ID_RE.source} without path traversal segments.`,
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
      lastErr = err;
      sleepSync(50 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function ensureBridgeDirs(workspaceRoot: string): void {
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
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
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

/** A real (non-linked) directory that holds HEAD — what git itself would accept as a git dir. */
function isGitDir(dir: string): boolean {
  return Boolean(lstatOrNull(dir)?.isDirectory()) && fs.existsSync(path.join(dir, 'HEAD'));
}

/** `.git` file (linked worktree, submodule) → the common git dir that owns `info/`. */
function commonDirFromGitFile(dotGitFile: string): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, 'utf8'));
  if (!match) {
    return null;
  }
  const gitDir = path.resolve(path.dirname(dotGitFile), match[1]);
  if (!isGitDir(gitDir)) {
    return null;
  }
  const commondirFile = path.join(gitDir, 'commondir');
  if (!fs.existsSync(commondirFile)) {
    return gitDir;
  }
  const commonDir = path.resolve(gitDir, fs.readFileSync(commondirFile, 'utf8').trim());
  return isGitDir(commonDir) ? commonDir : null;
}

/**
 * Absolute path of the repository's `info/exclude` for a workspace, or null when the workspace
 * is not inside a git work tree or that file is not safe to write (ADR-005).
 *
 * Resolved WITHOUT running git: the SessionStart hook runs in every folder Claude Code opens, and
 * a bare `git` spawned there executes a binary planted in that folder when PATH holds a relative
 * entry such as "." (measured on Windows). Walks up to the nearest `.git` (honouring
 * GIT_CEILING_DIRECTORIES), follows `.git` files and `commondir` for worktrees and submodules,
 * and refuses links: a `.git`, `info` or `exclude` that is a symlink or junction yields null.
 */
export function resolveGitExcludePath(workspaceRoot: string): string | null {
  const caseFold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => caseFold(path.resolve(dir)));

  let commonDir: string | null = null;
  for (let dir = path.resolve(workspaceRoot); ; ) {
    const dotGit = path.join(dir, '.git');
    const stat = lstatOrNull(dotGit);
    if (stat) {
      if (stat.isDirectory()) {
        commonDir = isGitDir(dotGit) ? dotGit : null;
      } else if (stat.isFile()) {
        commonDir = commonDirFromGitFile(dotGit);
      }
      break; // a linked `.git` is never followed
    }
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.includes(caseFold(parent))) {
      break;
    }
    dir = parent;
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

  // Prune old history files beyond MAX_HISTORY_ITEMS
  const files = fs
    .readdirSync(historyDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(historyDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

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

export function acquireBridgeLock(
  workspaceRoot: string,
  timeoutSec: number,
  nowMs: number = Date.now(),
): { warnings: string[] } {
  const warnings: string[] = [];
  const current = readManifest(workspaceRoot);
  if (!current) {
    return { warnings };
  }

  if (current.status === 'DISPATCHED' || current.status === 'RUNNING') {
    const updatedMs = Date.parse(current.updatedAt);
    const elapsedMs = Number.isNaN(updatedMs) ? Number.POSITIVE_INFINITY : nowMs - updatedMs;
    if (elapsedMs <= timeoutSec * 1000) {
      throw new AgPluginError(
        'BRIDGE_BUSY',
        `Another delegation task (${current.taskId}, status=${current.status}) is currently active (${Math.round(elapsedMs / 1000)}s elapsed). Wait for completion or inspect .ag-bridge/manifest.json.`,
        { activeTaskId: current.taskId, status: current.status },
      );
    }

    // Stale lock recovery
    const staleManifest: BridgeManifest = {
      ...current,
      status: 'FAILED',
      updatedAt: new Date(nowMs).toISOString(),
      errorCode: 'TASK_TIMEOUT',
      error: `Recovered stale task lock after ${Math.round(elapsedMs / 1000)}s without updates.`,
    };
    archiveManifest(workspaceRoot, staleManifest);
    warnings.push(
      `Recovered stale active task "${current.taskId}" (exceeded ${timeoutSec}s timeout) and archived it to .ag-bridge/history/.`,
    );
    return { warnings };
  }

  if (current.status === 'VERIFIED' || current.status === 'FAILED') {
    archiveManifest(workspaceRoot, current);
  }

  return { warnings };
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

export function readReportMarkdown(workspaceRoot: string): string | null {
  const reportPath = getReportPath(workspaceRoot);
  if (!fs.existsSync(reportPath)) {
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

  const targets = [path.join(workspaceRoot, '.agent', 'workflows', 'claude-handoff.md')];

  // ADR-003: Also mirror into .agents/workflows/ if the workspace already uses .agents/
  if (fs.existsSync(path.join(workspaceRoot, '.agents'))) {
    targets.push(path.join(workspaceRoot, '.agents', 'workflows', 'claude-handoff.md'));
  }

  const syncedPaths: string[] = [];
  const skippedCustomPaths: string[] = [];

  for (const target of targets) {
    if (!fs.existsSync(target)) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
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
