import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireBridgeLock,
  archiveManifest,
  atomicWriteFile,
  ensureGitignoreEntry,
  getBridgeDir,
  getHistoryDir,
  GIT_EXCLUDE_PATTERNS,
  isGitignoreProtected,
  readArchivedManifest,
  writeManifest,
} from '../src/bridge-fs.js';
import { runCliInit } from '../src/cli-init.js';
import { AgPluginError, BridgeManifest } from '../src/types.js';

describe('bridge-fs & cli-init (TC-U04 ~ TC-U06, TC-U10)', () => {
  let tmpRoot: string;
  let gitHome: string;
  let savedCeiling: string | undefined;
  const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

  // Hermetic git for the assertions: a developer's global excludesFile could already hide
  // `.agent/` and make a regression pass locally.
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        XDG_CONFIG_HOME: gitHome,
      },
    }).trim();
  const initRepo = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
  };
  const commitAll = (dir: string): void => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
  };
  const porcelain = (dir: string): string => git(dir, 'status', '--porcelain', '--untracked-files=all');
  const countLines = (file: string, line: string): number =>
    fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() === line).length;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bridge-'));
    gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-git-home-'));
    fs.writeFileSync(path.join(gitHome, 'gitconfig'), '');
    // Never let the workspace resolve to a repository that happens to enclose os.tmpdir().
    savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmpRoot);
  });

  afterEach(() => {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(gitHome, { recursive: true, force: true });
  });

  it('TC-U04: outside a git work tree, ensures .gitignore contains .ag-bridge/ idempotently', () => {
    const first = ensureGitignoreEntry(tmpRoot);
    expect(first).toEqual({ updated: true, protected: true, file: 'gitignore' });

    const second = ensureGitignoreEntry(tmpRoot);
    expect(second).toEqual({ updated: false, protected: true, file: 'gitignore' });

    const content = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    const occurrences = content.match(/\.ag-bridge\//g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it('TC-U04b: in a git work tree, registers .ag-bridge/ and the handoff templates in .git/info/exclude, never in .gitignore', () => {
    initRepo(tmpRoot);
    const exclude = path.join(tmpRoot, '.git', 'info', 'exclude');

    expect(ensureGitignoreEntry(tmpRoot)).toEqual({ updated: true, protected: true, file: 'git-info-exclude' });
    expect(ensureGitignoreEntry(tmpRoot)).toEqual({ updated: false, protected: true, file: 'git-info-exclude' });

    expect(fs.existsSync(path.join(tmpRoot, '.gitignore'))).toBe(false);
    for (const pattern of GIT_EXCLUDE_PATTERNS) {
      expect(countLines(exclude, pattern), pattern).toBe(1);
    }
    expect(isGitignoreProtected(tmpRoot)).toBe(true);
  });

  it('TC-U04c: cli-init leaves `git status` clean in a repository — no tracked-file edit, no untracked bridge or template file', () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# repo\n');
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(tmpRoot, '.agents', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.agents', 'rules', 'team.md'), '# team rule\n');
    commitAll(tmpRoot);

    const res = runCliInit({ workspaceRoot: tmpRoot, silent: true, forceTemplate: false, pluginRoot });

    expect(res.ignoreFile).toBe('git-info-exclude');
    expect(res.syncedTemplates).toHaveLength(2); // .agent/ and the .agents/ mirror
    expect(porcelain(tmpRoot)).toBe('');
    expect(fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('TC-U04d: leaves a .gitignore entry written by older versions untouched and still hides the templates', () => {
    initRepo(tmpRoot);
    const legacy = 'dist/\n\n# Antigravity Claude Bridge (local session artifacts)\n.ag-bridge/\n';
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), legacy);
    commitAll(tmpRoot);

    runCliInit({ workspaceRoot: tmpRoot, silent: true, forceTemplate: false, pluginRoot });

    expect(fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8')).toBe(legacy);
    expect(porcelain(tmpRoot)).toBe('');
  });

  it('TC-U04e: from a subdirectory workspace, writes the repository exclude file and hides the nested bridge and template', () => {
    initRepo(tmpRoot);
    const sub = path.join(tmpRoot, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'index.ts'), 'export {};\n');
    commitAll(tmpRoot);

    const res = runCliInit({ workspaceRoot: sub, silent: true, forceTemplate: false, pluginRoot });

    expect(res.ignoreFile).toBe('git-info-exclude');
    expect(fs.existsSync(path.join(sub, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(sub, '.agent', 'workflows', 'claude-handoff.md'))).toBe(true);
    expect(porcelain(tmpRoot)).toBe('');
  });

  it('TC-U04f: in a linked worktree, uses the info/exclude shared with the main repository', () => {
    const main = path.join(tmpRoot, 'main');
    const linked = path.join(tmpRoot, 'linked');
    initRepo(main);
    fs.writeFileSync(path.join(main, 'README.md'), '# repo\n');
    commitAll(main);
    git(main, 'worktree', 'add', '-q', linked);

    const res = runCliInit({ workspaceRoot: linked, silent: true, forceTemplate: false, pluginRoot });

    expect(res.ignoreFile).toBe('git-info-exclude');
    expect(countLines(path.join(main, '.git', 'info', 'exclude'), '.ag-bridge/')).toBe(1);
    expect(fs.existsSync(path.join(linked, '.gitignore'))).toBe(false);
    expect(porcelain(linked)).toBe('');
  });

  it('TC-U05: rejects concurrent dispatch with BRIDGE_BUSY when active task is within timeout', () => {
    const now = new Date().toISOString();
    const active: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'ag-active-1',
      title: 'Active UI task',
      mode: 'subscription',
      status: 'RUNNING',
      lockedPaths: ['src/'],
      createdAt: now,
      updatedAt: now,
      artifacts: [],
    };
    writeManifest(tmpRoot, active);

    try {
      acquireBridgeLock(tmpRoot, 300);
      expect.unreachable('should have thrown BRIDGE_BUSY');
    } catch (err) {
      expect(err).toBeInstanceOf(AgPluginError);
      expect((err as AgPluginError).code).toBe('BRIDGE_BUSY');
    }
  });

  it('TC-U06: recovers stale RUNNING lock past timeout_sec and archives it', () => {
    const oldTime = new Date(Date.now() - 400_000).toISOString();
    const stale: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'ag-stale-1',
      title: 'Stale task',
      mode: 'subscription',
      status: 'RUNNING',
      lockedPaths: ['src/'],
      createdAt: oldTime,
      updatedAt: oldTime,
      artifacts: [],
    };
    writeManifest(tmpRoot, stale);

    const res = acquireBridgeLock(tmpRoot, 300);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain('ag-stale-1');

    const archived = readArchivedManifest(tmpRoot, 'ag-stale-1');
    expect(archived?.status).toBe('FAILED');
    expect(archived?.errorCode).toBe('TASK_TIMEOUT');
  });

  it('TC-U10: cli-init initializes config, .gitignore, and syncs claude-handoff.md (including .agents/ mirror)', () => {
    fs.mkdirSync(path.join(tmpRoot, '.agents'), { recursive: true });
    const res = runCliInit({
      workspaceRoot: tmpRoot,
      silent: true,
      forceTemplate: false,
      pluginRoot,
    });

    expect(res.configCreated).toBe(true);
    expect(res.ignoreUpdated).toBe(true);
    expect(res.ignoreFile).toBe('gitignore'); // tmpRoot is not a git work tree
    expect(fs.existsSync(path.join(tmpRoot, '.ag-bridge', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, '.agent', 'workflows', 'claude-handoff.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, '.agents', 'workflows', 'claude-handoff.md'))).toBe(true);

    // Custom user file without template version header should not be clobbered
    const handoffPath = path.join(tmpRoot, '.agent', 'workflows', 'claude-handoff.md');
    fs.writeFileSync(handoffPath, '# Custom user workflow\n', 'utf8');
    const second = runCliInit({
      workspaceRoot: tmpRoot,
      silent: true,
      forceTemplate: false,
      pluginRoot,
    });
    expect(second.skippedCustomTemplates).toContain(handoffPath);
    expect(fs.readFileSync(handoffPath, 'utf8')).toBe('# Custom user workflow\n');

    // Outdated plugin template version should upgrade automatically
    fs.writeFileSync(handoffPath, '<!-- ag-plugin-template-version: 0.9.0 -->\n# Old\n', 'utf8');
    const upgraded = runCliInit({
      workspaceRoot: tmpRoot,
      silent: true,
      forceTemplate: false,
      pluginRoot,
    });
    expect(upgraded.syncedTemplates).toContain(handoffPath);
    expect(fs.readFileSync(handoffPath, 'utf8')).toContain('ag-plugin-template-version: 1.0.0');

    // --force-template overwrites custom user file
    fs.writeFileSync(handoffPath, '# Custom user workflow\n', 'utf8');
    const forced = runCliInit({
      workspaceRoot: tmpRoot,
      silent: true,
      forceTemplate: true,
      pluginRoot,
    });
    expect(forced.syncedTemplates).toContain(handoffPath);
    expect(fs.readFileSync(handoffPath, 'utf8')).toContain('ag-plugin-template-version: 1.0.0');
  });

  it('prunes history archive to 20 most recent tasks and leaves zero stray .tmp files', () => {
    const target = path.join(getBridgeDir(tmpRoot), 'sample.json');
    atomicWriteFile(target, '{"ok":true}\n');
    const strayTmp = fs.readdirSync(getBridgeDir(tmpRoot)).filter((f) => f.endsWith('.tmp'));
    expect(strayTmp).toEqual([]);

    for (let i = 1; i <= 25; i++) {
      archiveManifest(tmpRoot, {
        schemaVersion: 1,
        taskId: `ag-hist-${String(i).padStart(2, '0')}`,
        title: `Task ${i}`,
        mode: 'api',
        status: 'VERIFIED',
        lockedPaths: ['src/'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      });
    }

    const archivedFiles = fs.readdirSync(getHistoryDir(tmpRoot)).filter((f) => f.endsWith('.json'));
    expect(archivedFiles.length).toBe(20);
  });
});
