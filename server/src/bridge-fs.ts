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
  return taskId ? path.join(base, taskId) : base;
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

export function isGitignoreProtected(workspaceRoot: string): boolean {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const lines = fs
    .readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  return lines.some((line) => line === '.ag-bridge' || line === '.ag-bridge/' || line === '/.ag-bridge/');
}

export function ensureGitignoreEntry(workspaceRoot: string): { updated: boolean; protected: boolean } {
  if (isGitignoreProtected(workspaceRoot)) {
    return { updated: false, protected: true };
  }

  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const block = '# Antigravity Claude Bridge (local session artifacts)\n.ag-bridge/\n';

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, block, 'utf8');
    return { updated: true, protected: true };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsLeadingNewline ? '\n\n' : existing.length > 0 ? '\n' : ''}${block}`;
  fs.appendFileSync(gitignorePath, addition, 'utf8');
  return { updated: true, protected: true };
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
  const historyDir = getHistoryDir(workspaceRoot);
  const archivePath = path.join(historyDir, `${manifest.taskId}.json`);
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
  const archivePath = path.join(getHistoryDir(workspaceRoot), `${taskId}.json`);
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
