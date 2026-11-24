import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpoint, getGitInfo, rollbackCheckpoint } from '../src/git-guard.js';
import { AgPluginError, BridgeManifest } from '../src/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n', 'utf8');
  git(dir, ['add', 'app.ts']);
  git(dir, ['commit', '-m', 'Initial commit']);
}

// Windows: the fake git is a Node binary named git.exe. It is linked from a private copy, never
// from process.execPath: a link to the running image cannot be unlinked on Node 20 (EPERM).
let fakeNodeDir: string | undefined;
function fakeNodeBinary(): string {
  if (!fakeNodeDir) {
    fakeNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fake-node-'));
    fs.copyFileSync(process.execPath, path.join(fakeNodeDir, 'node.exe'));
  }
  return path.join(fakeNodeDir, 'node.exe');
}

/**
 * Plant a fake `git` in `dir` that answers `git status …` with a porcelain header naming itself.
 * Windows: a Node binary named git.exe runs `<cwd>/status` as its script.
 */
function plantFakeGit(dir: string): void {
  if (process.platform === 'win32') {
    try {
      fs.linkSync(fakeNodeBinary(), path.join(dir, 'git.exe'));
    } catch {
      fs.copyFileSync(fakeNodeBinary(), path.join(dir, 'git.exe'));
    }
    fs.writeFileSync(path.join(dir, 'status'), "process.stdout.write('## planted-by-workspace\\n');\n");
  } else {
    fs.writeFileSync(path.join(dir, 'git'), "#!/bin/sh\necho '## planted-by-workspace'\n", { mode: 0o755 });
  }
}

/**
 * Run `fn` the way the MCP server runs in production — its cwd is the opened workspace — with
 * PATH replaced by `makePath(original)`. Measured: a bare `git` then runs a planted one once PATH
 * holds ".".
 */
function servedFrom<T>(workspace: string, makePath: (original: string) => string, fn: () => T): T {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const savedPath = process.env[key];
  const savedCwd = process.cwd();
  process.env[key] = makePath(savedPath ?? '');
  process.chdir(workspace);
  try {
    return fn();
  } finally {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env[key];
    else process.env[key] = savedPath;
  }
}
const dotFirst = (original: string): string => `.${path.delimiter}${original}`;

describe('git-guard (TC-U07 ~ TC-U09, TC-S14)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gitguard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    if (fakeNodeDir) fs.rmSync(fakeNodeDir, { recursive: true, force: true });
  });

  it('TC-U07: creates clean checkpoint and rolls back modified + newly created files', () => {
    initRepo(tmpRoot);
    const cp = createCheckpoint(tmpRoot, 'task-clean-1', 'best_effort');
    expect(cp.checkpointRef).toBeTruthy();
    expect(cp.isStashSnapshot).toBe(false);

    // Simulate delegated edits
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'new-ui.tsx'), 'export const UI = () => null;\n', 'utf8');

    const manifest: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'task-clean-1',
      title: 'Clean rollback test',
      mode: 'api',
      status: 'VERIFIED',
      lockedPaths: ['app.ts', 'new-ui.tsx'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: cp.checkpointRef,
      gitCheckpointIsStash: cp.isStashSnapshot,
      gitUntrackedBaseline: cp.untrackedBaseline,
      artifacts: [],
    };

    const rb = rollbackCheckpoint(tmpRoot, manifest);
    expect(rb.removedUntrackedFiles).toContain('new-ui.tsx');
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');
    expect(fs.existsSync(path.join(tmpRoot, 'new-ui.tsx'))).toBe(false);
  });

  it('TC-U08: preserves pre-existing dirty edits and pre-existing untracked files on rollback', () => {
    initRepo(tmpRoot);
    // User had uncommitted edit + untracked scratch note BEFORE delegation
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 2; // user dirty edit\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'user-notes.txt'), 'keep me!\n', 'utf8');

    const cp = createCheckpoint(tmpRoot, 'task-dirty-1', 'best_effort');
    expect(cp.checkpointRef).toBeTruthy();
    expect(cp.isStashSnapshot).toBe(true);
    expect(cp.untrackedBaseline).toContain('user-notes.txt');

    // Delegated agent overwrites app.ts and creates a new component
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 42; // agent edit\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'agent-created.tsx'), 'export default 1;\n', 'utf8');

    const manifest: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'task-dirty-1',
      title: 'Dirty rollback test',
      mode: 'api',
      status: 'FAILED',
      lockedPaths: ['app.ts', 'agent-created.tsx'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: cp.checkpointRef,
      gitCheckpointIsStash: cp.isStashSnapshot,
      gitUntrackedBaseline: cp.untrackedBaseline,
      artifacts: [],
    };

    const rb = rollbackCheckpoint(tmpRoot, manifest);
    expect(rb.removedUntrackedFiles).toContain('agent-created.tsx');
    expect(rb.removedUntrackedFiles).not.toContain('user-notes.txt');
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe(
      'export const version = 2; // user dirty edit\n',
    );
    expect(fs.existsSync(path.join(tmpRoot, 'user-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'agent-created.tsx'))).toBe(false);
  });

  it('TC-U09: handles non-git workspaces according to best_effort vs required policy', () => {
    const res = createCheckpoint(tmpRoot, 'task-nogit-1', 'best_effort');
    expect(res.checkpointRef).toBeUndefined();
    expect(res.warning).toContain('not a Git repository');

    expect(() => createCheckpoint(tmpRoot, 'task-nogit-2', 'required')).toThrow(AgPluginError);
  });

  it('TC-S14: a git the workspace ships never runs, even with "." on PATH (non-repo folder)', () => {
    plantFakeGit(tmpRoot);
    const info = servedFrom(tmpRoot, dotFirst, () => getGitInfo(tmpRoot));
    expect(info).toEqual({ isGitRepo: false });
  });

  it('TC-S14b: in a repository that ships a git binary, Git Guard still reads the real branch', () => {
    initRepo(tmpRoot);
    const realBranch = git(tmpRoot, ['symbolic-ref', '--short', 'HEAD']); // before planting
    plantFakeGit(tmpRoot);
    const info = servedFrom(tmpRoot, dotFirst, () => getGitInfo(tmpRoot));
    expect(info.isGitRepo).toBe(true);
    expect(info.currentBranch).toBe(realBranch);
  });

  it('TC-S14c: with no absolute PATH entry holding git, Git Guard reports no repository instead of falling back to a bare name', () => {
    initRepo(tmpRoot);
    plantFakeGit(tmpRoot);
    const info = servedFrom(tmpRoot, () => '.', () => getGitInfo(tmpRoot));
    expect(info).toEqual({ isGitRepo: false });
  });

  it('TC-U11: restores staged edits, unstaged edits, and deleted tracked files cleanly on rollback', () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'extra.ts'), 'export const extra = 1;\n', 'utf8');
    git(tmpRoot, ['add', 'extra.ts']);
    git(tmpRoot, ['commit', '-m', 'Add extra.ts']);

    // User stages edit to app.ts AND leaves unstaged edit to extra.ts
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 2; // staged\n', 'utf8');
    git(tmpRoot, ['add', 'app.ts']);
    fs.writeFileSync(path.join(tmpRoot, 'extra.ts'), 'export const extra = 2; // unstaged\n', 'utf8');

    const info = getGitInfo(tmpRoot);
    expect(info.isGitRepo).toBe(true);
    expect(info.isDirty).toBe(true);
    expect(info.currentBranch).toBeTruthy();

    const cp = createCheckpoint(tmpRoot, 'task-staged-1', 'best_effort');
    expect(cp.isStashSnapshot).toBe(true);

    // Delegated agent corrupts app.ts and deletes extra.ts
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
    fs.unlinkSync(path.join(tmpRoot, 'extra.ts'));

    rollbackCheckpoint(tmpRoot, {
      schemaVersion: 1,
      taskId: 'task-staged-1',
      title: 'Staged rollback test',
      mode: 'api',
      status: 'FAILED',
      lockedPaths: ['app.ts', 'extra.ts'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: cp.checkpointRef,
      gitCheckpointIsStash: cp.isStashSnapshot,
      gitUntrackedBaseline: cp.untrackedBaseline,
      artifacts: [],
    });

    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe(
      'export const version = 2; // staged\n',
    );
    expect(fs.readFileSync(path.join(tmpRoot, 'extra.ts'), 'utf8')).toBe(
      'export const extra = 2; // unstaged\n',
    );
    expect(git(tmpRoot, ['diff', '--cached', '--name-only'])).toBe('app.ts');
  });
});
