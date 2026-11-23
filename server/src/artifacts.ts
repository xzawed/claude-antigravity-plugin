import fs from 'node:fs';
import path from 'node:path';
import {
  getArtifactsDir,
  getBridgeDir,
  readAllTaskManifests,
  readArchivedManifest,
  readManifest,
  readReportMarkdown,
} from './bridge-fs.js';
import { maskSecrets } from './config.js';
import {
  AgArtifactEntry,
  AgArtifactKind,
  ListArtifactsToolInput,
  ListArtifactsToolOutput,
} from './types.js';

function classifyArtifactKind(filePath: string): AgArtifactKind {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) return 'screenshot';
  if (ext === '.log' || ext === '.txt') return 'log';
  if (ext === '.md') return 'report';
  if (ext === '.json') return 'json';
  return 'other';
}

function collectArtifactFiles(workspaceRoot: string, taskId: string): AgArtifactEntry[] {
  const artDir = getArtifactsDir(workspaceRoot, taskId);
  if (!fs.existsSync(artDir)) return [];

  const entries: AgArtifactEntry[] = [];
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile()) {
        try {
          const stat = fs.statSync(full);
          entries.push({
            name: dirent.name,
            relativePath: path.relative(workspaceRoot, full).replace(/\\/g, '/'),
            absolutePath: full,
            kind: classifyArtifactKind(full),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          // ignore transient file error
        }
      }
    }
  };

  walk(artDir);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function readMaskedLogTail(workspaceRoot: string, taskId: string, maxLines: number): string | undefined {
  const logPath = path.join(getArtifactsDir(workspaceRoot, taskId), 'agy-cli.log');
  if (!fs.existsSync(logPath)) return undefined;
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return undefined;
    return maskSecrets(lines.slice(-Math.max(1, maxLines)).join('\n'));
  } catch {
    return undefined;
  }
}

export function handleListArtifacts(
  input: ListArtifactsToolInput = {},
): ListArtifactsToolOutput {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const current = readManifest(workspaceRoot);
  const allManifests = readAllTaskManifests(workspaceRoot);

  // Also discover any orphan artifact folders under .ag-bridge/artifacts/
  const artifactsRoot = path.join(getBridgeDir(workspaceRoot), 'artifacts');
  const seenIds = new Set<string>();
  const availableTasks: ListArtifactsToolOutput['availableTasks'] = [];

  for (const m of allManifests) {
    seenIds.add(m.taskId);
    const files = collectArtifactFiles(workspaceRoot, m.taskId);
    availableTasks.push({
      taskId: m.taskId,
      title: m.title,
      status: m.status,
      artifactCount: files.length,
      updatedAt: m.updatedAt,
    });
  }

  if (fs.existsSync(artifactsRoot)) {
    for (const dirent of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory() || seenIds.has(dirent.name)) continue;
      const files = collectArtifactFiles(workspaceRoot, dirent.name);
      availableTasks.push({
        taskId: dirent.name,
        title: '(Artifact folder)',
        status: 'IDLE',
        artifactCount: files.length,
        updatedAt: files[0]?.modifiedAt ?? new Date(0).toISOString(),
      });
    }
  }

  const targetTaskId = input.taskId ?? current?.taskId ?? availableTasks[0]?.taskId;
  if (!targetTaskId) {
    return {
      ok: true,
      workspaceRoot,
      artifacts: [],
      availableTasks: [],
    };
  }

  const targetManifest =
    current?.taskId === targetTaskId
      ? current
      : readArchivedManifest(workspaceRoot, targetTaskId);

  const artifacts = collectArtifactFiles(workspaceRoot, targetTaskId);
  const includeReport = input.includeReport ?? true;
  const includeLogTail = input.includeLogTail ?? true;
  const logTailLines = Math.min(200, Math.max(5, input.logTailLines ?? 40));

  let reportMarkdown: string | undefined;
  if (includeReport && current?.taskId === targetTaskId) {
    const raw = readReportMarkdown(workspaceRoot);
    if (raw) reportMarkdown = maskSecrets(raw);
  }

  const logTail = includeLogTail
    ? readMaskedLogTail(workspaceRoot, targetTaskId, logTailLines)
    : undefined;

  return {
    ok: true,
    workspaceRoot,
    taskId: targetTaskId,
    taskTitle: targetManifest?.title,
    taskStatus: targetManifest?.status,
    artifacts,
    reportMarkdown,
    logTail,
    availableTasks: availableTasks.slice(0, 20),
  };
}
