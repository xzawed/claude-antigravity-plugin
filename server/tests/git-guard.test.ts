import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkpointManifestFields,
  createCheckpoint,
  createTaskWorktree,
  endPosixLeftovers,
  getGitInfo,
  listGitChangedFiles,
  listUntrackedFiles,
  pruneRecoveryArtifacts,
  removeTaskWorktree,
  rollbackCheckpoint,
} from '../src/git-guard.js';
import { resolveExecutable } from '../src/exec-path.js';
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

  afterEach(async () => {
    // TC-U34 cuts git off, but where `git` is Git for Windows' launcher (cmd\git.exe, as on the CI
    // runners) only the launcher dies: the real git runs on through its filter calls and keeps
    // the folder busy (measured: still running after the cut, folder free after 7.5 s locally;
    // over 10 s on Windows CI). rmSync's maxRetries did not wait, so wait here.
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (Date.now() > deadline || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }, 60_000);

  afterAll(() => {
    if (fakeNodeDir) fs.rmSync(fakeNodeDir, { recursive: true, force: true });
  });

  // The checkpoint's fields go through the same mapping index.ts and jobs.ts use.
  const manifestFor = (taskId: string, cp: ReturnType<typeof createCheckpoint>, withBaseline: boolean): BridgeManifest => {
    const { gitUntrackedBaseline, ...fields } = checkpointManifestFields(cp);
    return {
      schemaVersion: 1,
      taskId,
      title: taskId,
      mode: 'api',
      status: 'VERIFIED',
      lockedPaths: ['.'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...fields,
      ...(withBaseline ? { gitUntrackedBaseline } : {}),
      artifacts: [],
    };
  };

  it('TC-S22: a rollback whose checkpoint has no untracked baseline deletes no untracked file', () => {
    // Without a baseline nothing tells the user's own untracked files from the agent's; the old
    // code treated "unknown" as "none" and deleted every untracked file.
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'user-notes.txt'), 'mine\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-no-baseline', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'agent-new.ts'), 'export {};\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-no-baseline', cp, false));
    expect(fs.existsSync(path.join(tmpRoot, 'user-notes.txt'))).toBe(true);
    expect(res.removedUntrackedFiles).toEqual([]);
    expect(res.untrackedBaselineMissing).toBe(true);
  });

  it.skipIf(process.platform === 'linux')(
    'TC-S22c: on a case-insensitive file system a tracked file renamed only in case survives rollback',
    () => {
      // Antigravity leg, measured: with core.ignorecase=false (a repository brought from Linux),
      // `ls-files --others` lists the tracked Foo.txt as untracked "foo.txt" once its case differs.
      git(tmpRoot, ['init']);
      git(tmpRoot, ['config', 'user.email', 'test@example.com']);
      git(tmpRoot, ['config', 'user.name', 'Test User']);
      git(tmpRoot, ['config', 'core.ignorecase', 'false']);
      fs.writeFileSync(path.join(tmpRoot, 'Foo.txt'), 'tracked\n', 'utf8');
      git(tmpRoot, ['add', 'Foo.txt']);
      git(tmpRoot, ['commit', '-qm', 'init']);
      const cp = createCheckpoint(tmpRoot, 'task-case', 'best_effort');
      fs.renameSync(path.join(tmpRoot, 'Foo.txt'), path.join(tmpRoot, 'foo.txt')); // the agent's case-only rename

      rollbackCheckpoint(tmpRoot, manifestFor('task-case', cp, true));
      expect(fs.readdirSync(tmpRoot).filter((n) => n.toLowerCase() === 'foo.txt')).toHaveLength(1);
    },
  );

  it('TC-S22b: a failed untracked-file listing is not mistaken for "no untracked files"', () => {
    expect(listUntrackedFiles(tmpRoot)).toBeUndefined(); // not a repository: git fails
    initRepo(tmpRoot);
    expect(listUntrackedFiles(tmpRoot)).toEqual([]);
  });

  // The agent can run git itself. A rollback must still return the user's state (Grok leg,
  // measured: `git add -A` made reset --hard delete the user's untracked notes).
  const withUserUntracked = (dirty: boolean): void => {
    initRepo(tmpRoot);
    if (dirty) fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 2; // user edit\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'USER NOTES\n', 'utf8');
  };

  it("TC-S23: a user's untracked file that the agent staged and committed survives rollback", () => {
    withUserUntracked(false);
    const checkpointHead = git(tmpRoot, ['rev-parse', 'HEAD']);
    const cp = createCheckpoint(tmpRoot, 'task-add-commit', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
    git(tmpRoot, ['add', '-A']);
    git(tmpRoot, ['commit', '-qm', 'agent work']);

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-add-commit', cp, true));
    expect(fs.existsSync(path.join(tmpRoot, 'notes.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRoot, 'notes.txt'), 'utf8')).toBe('USER NOTES\n');
    expect(git(tmpRoot, ['ls-files', '--', 'notes.txt'])).toBe(''); // untracked again, as before
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');
    expect(git(tmpRoot, ['rev-parse', 'HEAD'])).toBe(checkpointHead);
    expect(res.revertedTrackedFiles).toEqual(['app.ts']);
  });

  it("TC-S23b: a user's untracked file that the agent staged survives rollback of a dirty checkpoint", () => {
    withUserUntracked(true);
    const cp = createCheckpoint(tmpRoot, 'task-add-dirty', 'best_effort');
    expect(cp.isStashSnapshot).toBe(true);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
    git(tmpRoot, ['add', '-A']);

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-add-dirty', cp, true));
    expect(fs.existsSync(path.join(tmpRoot, 'notes.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const version = 2; // user edit\n');
    expect(res.revertedTrackedFiles).toEqual(['app.ts']);
  });

  it('TC-S23c: a dirty checkpoint rolls back cleanly after the agent committed on the same branch', () => {
    // Measured before the fix: the snapshot was applied on top of the agent's commit, conflicted
    // and left conflict markers in app.ts.
    withUserUntracked(true);
    const checkpointHead = git(tmpRoot, ['rev-parse', 'HEAD']);
    const cp = createCheckpoint(tmpRoot, 'task-dirty-commit', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
    git(tmpRoot, ['commit', '-qam', 'agent work']);

    rollbackCheckpoint(tmpRoot, manifestFor('task-dirty-commit', cp, true));
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const version = 2; // user edit\n');
    expect(git(tmpRoot, ['rev-parse', 'HEAD'])).toBe(checkpointHead);
  });

  it("TC-S23d: rollback refuses, changing nothing, when HEAD is no longer on the checkpoint's branch", () => {
    // Measured before the fix: after the agent switched to the user's dev, reset --hard moved dev
    // onto main's commit, taking the user's commit off the branch.
    initRepo(tmpRoot);
    const startBranch = git(tmpRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(tmpRoot, ['switch', '-q', '-c', 'dev']);
    fs.writeFileSync(path.join(tmpRoot, 'dev.ts'), 'user dev work\n', 'utf8');
    git(tmpRoot, ['add', 'dev.ts']);
    git(tmpRoot, ['commit', '-qm', 'user dev commit']);
    const devTip = git(tmpRoot, ['rev-parse', 'dev']);
    git(tmpRoot, ['switch', '-q', startBranch]);
    const cp = createCheckpoint(tmpRoot, 'task-switch', 'best_effort');
    git(tmpRoot, ['switch', '-q', 'dev']); // the agent moves to the user's other branch

    let thrown: unknown;
    try {
      rollbackCheckpoint(tmpRoot, manifestFor('task-switch', cp, true));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgPluginError);
    expect((thrown as AgPluginError).code).toBe('GIT_CHECKPOINT_FAILED');
    expect((thrown as Error).message).toContain('refs/heads/dev');
    expect((thrown as Error).message).toContain(`refs/heads/${startBranch}`);
    expect((thrown as Error).message).toContain(`git switch ${startBranch}`);
    expect(git(tmpRoot, ['rev-parse', 'dev'])).toBe(devTip);
    expect(fs.existsSync(path.join(tmpRoot, 'dev.ts'))).toBe(true);
  });

  it('TC-S23e: rollback never deletes a file .gitignore covers — the user\'s .env, or build output from the task', () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), '.env\ndist/\n', 'utf8');
    git(tmpRoot, ['add', '.gitignore']);
    git(tmpRoot, ['commit', '-qm', 'ignore']);
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SECRET=1\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-ignored', 'best_effort');
    fs.mkdirSync(path.join(tmpRoot, 'dist'));
    fs.writeFileSync(path.join(tmpRoot, 'dist', 'bundle.js'), 'built\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-ignored', cp, true));
    expect(fs.readFileSync(path.join(tmpRoot, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.existsSync(path.join(tmpRoot, 'dist', 'bundle.js'))).toBe(true);
    expect(res.removedUntrackedFiles).toEqual([]);
  });

  // Rollback keeps what it takes away (Claude, Grok, Antigravity, two rounds): the files it removes go
  // to .ag-bridge/recovery/, the user's untracked files are snapshotted under a cap, and the state
  // before reverting is recorded so the rollback itself can be undone.
  const read = (rel: string): string => fs.readFileSync(path.join(tmpRoot, rel), 'utf8');

  it('TC-S24: rollback moves the files the agent created into .ag-bridge/recovery instead of deleting them', () => {
    withUserUntracked(false);
    const cp = createCheckpoint(tmpRoot, 'task-q', 'best_effort');
    fs.mkdirSync(path.join(tmpRoot, 'gen'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'gen', 'agent.txt'), 'AGENT WORK\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-q', cp, true));
    expect(res.removedUntrackedFiles).toEqual(['gen/agent.txt']);
    expect(fs.existsSync(path.join(tmpRoot, 'gen', 'agent.txt'))).toBe(false);
    expect(res.quarantineDir).toMatch(/^\.ag-bridge\/recovery\/task-q\/rollback-/);
    expect(read(`${res.quarantineDir}/removed/gen/agent.txt`)).toBe('AGENT WORK\n');
    expect(read('notes.txt')).toBe('USER NOTES\n');
    expect(res.restoredUntrackedFiles).toEqual([]); // untouched user files are not "restored"
  });

  it("TC-S24g: a manifest pointing at another snapshot folder restores nothing from it (the manifest is the agent's to rewrite)", () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'USER NOTES\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-own', 'best_effort');
    const planted = path.join(tmpRoot, '.ag-bridge', 'recovery', 'task-other', 'untracked');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, 'notes.txt'), 'PLANTED\n', 'utf8');
    fs.writeFileSync(path.join(planted, 'extra.txt'), 'PLANTED\n', 'utf8');

    const manifest = { ...manifestFor('task-own', cp, true), gitUntrackedSnapshotDir: '.ag-bridge/recovery/task-other/untracked' };
    const res = rollbackCheckpoint(tmpRoot, manifest);
    expect(res.restoredUntrackedFiles).toEqual([]);
    expect(read('notes.txt')).toBe('USER NOTES\n');
    expect(fs.existsSync(path.join(tmpRoot, 'extra.txt'))).toBe(false);
  });

  it('TC-S24b: a file the agent created and then staged or committed goes to recovery too, not deleted by reset', () => {
    withUserUntracked(false);
    const cp = createCheckpoint(tmpRoot, 'task-q2', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'committed.ts'), 'COMMITTED\n', 'utf8');
    git(tmpRoot, ['add', 'committed.ts']);
    git(tmpRoot, ['commit', '-qm', 'agent']);
    fs.writeFileSync(path.join(tmpRoot, 'staged.ts'), 'STAGED\n', 'utf8');
    git(tmpRoot, ['add', 'staged.ts']);

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-q2', cp, true));
    expect(res.removedUntrackedFiles).toEqual(['committed.ts', 'staged.ts']);
    expect(read(`${res.quarantineDir}/removed/committed.ts`)).toBe('COMMITTED\n');
    expect(read(`${res.quarantineDir}/removed/staged.ts`)).toBe('STAGED\n');
    expect(fs.existsSync(path.join(tmpRoot, 'committed.ts'))).toBe(false);
    expect(res.revertedTrackedFiles).toEqual([]);
  });

  it("TC-S24c: rollback restores the user's untracked files the agent edited or deleted, keeping the agent's version", () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'USER NOTES\n', 'utf8');
    fs.mkdirSync(path.join(tmpRoot, 'docs'));
    fs.writeFileSync(path.join(tmpRoot, 'docs', 'draft.md'), 'USER DRAFT\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-s', 'best_effort');
    expect(cp.untrackedSnapshotDir).toBe('.ag-bridge/recovery/task-s/untracked');
    fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'AGENT OVERWROTE\n', 'utf8');
    fs.rmSync(path.join(tmpRoot, 'docs', 'draft.md'));

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-s', cp, true));
    expect(read('notes.txt')).toBe('USER NOTES\n');
    expect(read('docs/draft.md')).toBe('USER DRAFT\n');
    expect(res.restoredUntrackedFiles).toEqual(['docs/draft.md', 'notes.txt']);
    expect(read(`${res.quarantineDir}/replaced/notes.txt`)).toBe('AGENT OVERWROTE\n');
  });

  it('TC-S24f: restoring never writes through a link the agent put in place of a user folder', () => {
    initRepo(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'docs'));
    fs.writeFileSync(path.join(tmpRoot, 'docs', 'draft.md'), 'USER DRAFT\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-link', 'best_effort');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-outside-'));
    try {
      fs.rmSync(path.join(tmpRoot, 'docs'), { recursive: true });
      fs.symlinkSync(outside, path.join(tmpRoot, 'docs'), 'junction'); // the agent's link out of the workspace

      rollbackCheckpoint(tmpRoot, manifestFor('task-link', cp, true));
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(path.join(tmpRoot, 'docs')).isSymbolicLink()).toBe(false);
      expect(read('docs/draft.md')).toBe('USER DRAFT\n');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('TC-S24h: rollback never moves or deletes files behind a link — a junction the agent made to a folder with files', () => {
    // Antigravity review, measured: Windows git listed "docs/precious.txt" inside the junction's
    // outside target, and rollback moved it out of that folder (main deleted it).
    initRepo(tmpRoot);
    const cp = createCheckpoint(tmpRoot, 'task-out', 'best_effort');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'precious.txt'), 'OUTSIDE DATA\n', 'utf8');
      fs.symlinkSync(outside, path.join(tmpRoot, 'link-out'), 'junction');

      const res = rollbackCheckpoint(tmpRoot, manifestFor('task-out', cp, true));
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('OUTSIDE DATA\n');
      expect(res.removedUntrackedFiles).not.toContain('link-out/precious.txt');
      if (process.platform === 'win32') expect(res.pathsBehindLinks).toEqual(['link-out/precious.txt']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('TC-S24i: a file the agent re-created where it had removed a tracked one goes to recovery, not under reset', () => {
    // Antigravity review, measured: after `git rm lib.ts` and a new lib.ts, reset --hard overwrote it.
    initRepo(tmpRoot);
    const cp = createCheckpoint(tmpRoot, 'task-rm', 'best_effort');
    git(tmpRoot, ['rm', '-q', 'app.ts']);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'AGENT NEW APP\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-rm', cp, true));
    expect(read('app.ts')).toBe('export const version = 1;\n');
    expect(read(`${res.quarantineDir}/replaced/app.ts`)).toBe('AGENT NEW APP\n');
  });

  it("TC-S24j: when retention already removed a task's copy, rollback says it could not put the user's files back", () => {
    withUserUntracked(false);
    const cp = createCheckpoint(tmpRoot, 'task-gone', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'AGENT EDIT\n', 'utf8');
    fs.rmSync(path.join(tmpRoot, '.ag-bridge', 'recovery', 'task-gone', 'untracked'), { recursive: true, force: true });

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-gone', cp, true));
    expect(res.untrackedSnapshotMissing).toBe(true);
    expect(read('notes.txt')).toBe('AGENT EDIT\n');
  });

  // A 51 MB file and 2,001 files on the Windows CI runners took 3.0–4.2 s, then 9.2 s against
  // vitest's 5 s default (main 92836eb, Node 22): the test keeps an explicit limit.
  it('TC-S24d: untracked files over the snapshot cap (2,000 files or 50 MB) are not copied, and the checkpoint says so', { timeout: 60_000 }, () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'big.bin'), Buffer.alloc(51 * 1024 * 1024));
    const byBytes = createCheckpoint(tmpRoot, 'task-cap-mb', 'best_effort');
    expect(byBytes.checkpointRef).toBeTruthy();
    expect(byBytes.untrackedSnapshotDir).toBeUndefined();
    expect(byBytes.warning).toMatch(/not snapshotted/);
    expect(fs.existsSync(path.join(tmpRoot, '.ag-bridge', 'recovery', 'task-cap-mb', 'untracked'))).toBe(false);

    fs.rmSync(path.join(tmpRoot, 'big.bin'));
    fs.mkdirSync(path.join(tmpRoot, 'many'));
    for (let i = 0; i <= 2000; i++) fs.writeFileSync(path.join(tmpRoot, 'many', `f${i}.txt`), 'x');
    const byCount = createCheckpoint(tmpRoot, 'task-cap-n', 'best_effort');
    expect(byCount.untrackedSnapshotDir).toBeUndefined();
    expect(byCount.warning).toMatch(/not snapshotted/);
  });

  it('TC-S24e: before reverting, rollback records the agent\'s state so the rollback itself can be undone', () => {
    initRepo(tmpRoot);
    const cp = createCheckpoint(tmpRoot, 'task-p', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'lib.ts'), 'export const lib = 1; // agent, committed\n', 'utf8');
    git(tmpRoot, ['add', 'lib.ts']);
    git(tmpRoot, ['commit', '-qm', 'agent commit']);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999; // agent, uncommitted\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-p', cp, true));
    expect(read('app.ts')).toBe('export const version = 1;\n');
    expect(res.preRollbackRef).toBe('refs/ag-bridge/pre-rollback/task-p');
    expect(res.preRollbackHead).toMatch(/^[0-9a-f]{40}$/);

    // undo the rollback: back to the agent's commit, then its uncommitted edit
    git(tmpRoot, ['reset', '--hard', res.preRollbackHead!]);
    git(tmpRoot, ['stash', 'apply', res.preRollbackRef!]);
    expect(read('lib.ts')).toBe('export const lib = 1; // agent, committed\n');
    expect(read('app.ts')).toBe('export const version = 999; // agent, uncommitted\n');
  });

  it('TC-U38: recovery folders beyond the last 10 tasks, older than 7 days, or past the size cap are pruned with their refs', () => {
    initRepo(tmpRoot);
    const rec = path.join(tmpRoot, '.ag-bridge', 'recovery');
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const make = (id: string, ageDays: number, bytes: number): void => {
      const dir = path.join(rec, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f'), Buffer.alloc(bytes));
      const t = new Date(now - ageDays * day);
      fs.utimesSync(dir, t, t);
    };
    for (let i = 0; i < 12; i++) make(`t${i}`, i * 0.1, 10); // t0 newest … t11 oldest, all within 7 days
    make('old', 8, 10);
    const head = git(tmpRoot, ['rev-parse', 'HEAD']);
    git(tmpRoot, ['update-ref', 'refs/ag-bridge/pre-rollback/t10', head]);

    const policy = { maxTasks: 10, maxAgeMs: 7 * day, maxBytes: 250 * 1024 * 1024 };
    const pruned = pruneRecoveryArtifacts(tmpRoot, 't11', policy, now);
    expect([...pruned].sort()).toEqual(['old', 't10', 't9']); // t11 is the task at hand: always kept
    expect(fs.readdirSync(rec).sort()).toEqual(['t0', 't1', 't11', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    expect(() => git(tmpRoot, ['rev-parse', '--verify', 'refs/ag-bridge/pre-rollback/t10'])).toThrow();

    // size: newest first while the total stays within the cap
    fs.rmSync(rec, { recursive: true, force: true });
    make('a', 0.1, 60);
    make('b', 0.2, 50);
    make('c', 0.3, 50);
    expect(pruneRecoveryArtifacts(tmpRoot, undefined, { ...policy, maxBytes: 120 }, now)).toEqual(['c']);
  });

  it("TC-U36: rollback reports the tracked files it reverted, not the user's untouched untracked files", () => {
    withUserUntracked(false);
    const cp = createCheckpoint(tmpRoot, 'task-report', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-report', cp, true));
    expect(res.revertedTrackedFiles).toEqual(['app.ts']);
    expect(fs.existsSync(path.join(tmpRoot, 'notes.txt'))).toBe(true);
  });

  it('TC-U36b: a file the agent renamed is reverted under its old name; its new name goes to recovery', () => {
    // Since TC-S24b, what the agent added (the new name included) leaves the index before reset
    // and is moved to recovery instead of deleted, so it is reported as removed, not reverted.
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'lib.ts'), 'export const lib = 1;\n', 'utf8');
    git(tmpRoot, ['add', 'lib.ts']);
    git(tmpRoot, ['commit', '-qm', 'add lib']);
    const cp = createCheckpoint(tmpRoot, 'task-rename', 'best_effort');
    git(tmpRoot, ['mv', 'lib.ts', 'util.ts']);

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-rename', cp, true));
    expect(res.revertedTrackedFiles).toEqual(['lib.ts']);
    expect(res.removedUntrackedFiles).toEqual(['util.ts']);
    expect(fs.existsSync(path.join(tmpRoot, 'lib.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'util.ts'))).toBe(false);
    expect(read(`${res.quarantineDir}/removed/util.ts`)).toBe('export const lib = 1;\n');
  });

  it('TC-U35: rollback removes an agent file with a non-ASCII name and keeps the user\'s', () => {
    // git quotes such names ("\354\202\254…") unless asked for -z output (measured: the agent's
    // 에이전트결과.txt survived a rollback).
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, '사용자 메모.txt'), 'mine\n', 'utf8');
    const cp = createCheckpoint(tmpRoot, 'task-names', 'best_effort');
    fs.writeFileSync(path.join(tmpRoot, '에이전트결과.txt'), 'agent\n', 'utf8');

    const res = rollbackCheckpoint(tmpRoot, manifestFor('task-names', cp, true));
    expect(res.removedUntrackedFiles).toEqual(['에이전트결과.txt']);
    expect(fs.existsSync(path.join(tmpRoot, '에이전트결과.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, '사용자 메모.txt'))).toBe(true);
  });

  it('TC-U35b: changed files with non-ASCII names are reported as named', () => {
    initRepo(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, '설정.json'), '{}\n', 'utf8');
    git(tmpRoot, ['add', '설정.json']);
    git(tmpRoot, ['commit', '-qm', 'add settings']);
    fs.writeFileSync(path.join(tmpRoot, '설정.json'), '{"a":1}\n', 'utf8');
    expect(listGitChangedFiles(tmpRoot)).toEqual(['설정.json']);
  });

  // A clean filter that stalls (clean filters stay on by design, ARC-003 §8). Without a time limit
  // `git status` waits for it on every file it cleans: 16.6 s with `sleep 4` (measured).
  const stallingFilter = (): void => {
    initRepo(tmpRoot);
    const slow = path.join(tmpRoot, '.git', 'slow-filter.sh');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 8\ncat\n', { mode: 0o755 });
    git(tmpRoot, ['config', 'filter.slow.clean', slow.replace(/\\/g, '/')]);
    fs.writeFileSync(path.join(tmpRoot, '.gitattributes'), 'app.ts filter=slow\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 7;\n', 'utf8');
  };

  it('TC-U34: a git call that does not answer within the time limit is cut off', { timeout: 60_000 }, () => {
    stallingFilter();
    process.env.AG_GIT_TIMEOUT_MS = '1000';
    try {
      const started = Date.now();
      const info = getGitInfo(tmpRoot);
      // the 1 s limit, plus ending what git left running (one PowerShell, seconds on CI runners)
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(info.isGitRepo).toBe(false);
      expect(info.error).toContain('1000 ms');
    } finally {
      delete process.env.AG_GIT_TIMEOUT_MS;
    }
  });

  it.skipIf(process.platform !== 'win32')(
    "TC-U34b: on Windows the time limit also ends the git that Git for Windows' launcher left running",
    { timeout: 120_000 },
    async (ctx) => {
      // `git` on PATH is usually a launcher: <root>\cmd\git.exe (the default install's PATH entry) or
      // <root>\bin\git.exe (the CI runners'). The limit killed only the launcher; the real git ran on
      // through its filters and held the folder (measured: still running after the cut, gone at
      // 6.9 s). Find <root>\cmd\git.exe from wherever git resolves — <root>\cmd, <root>\bin, or
      // <root>\mingw64\bin (Git Bash) — so this runs on CI too (it was skipped there at first).
      const resolved = resolveExecutable('git') ?? '';
      const launcher = [
        resolved,
        path.join(path.dirname(resolved), '..', 'cmd', 'git.exe'),
        path.join(path.dirname(resolved), '..', '..', 'cmd', 'git.exe'),
      ].find((p) => resolved && /\\cmd\\git\.exe$/i.test(path.normalize(p)) && fs.existsSync(p));
      if (!launcher) {
        ctx.skip(); // not Git for Windows
        return;
      }
      stallingFilter();
      const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      const savedPath = process.env[key];
      process.env[key] = `${path.dirname(launcher)}${path.delimiter}${savedPath ?? ''}`;
      process.env.AG_GIT_TIMEOUT_MS = '1000';
      let info: ReturnType<typeof getGitInfo>;
      try {
        info = getGitInfo(tmpRoot);
      } finally {
        if (savedPath === undefined) delete process.env[key];
        else process.env[key] = savedPath;
        delete process.env.AG_GIT_TIMEOUT_MS;
      }
      expect(info.isGitRepo).toBe(false);
      // the real git AND the filter it started (measured: 2 in each of 4 runs) — not just the child
      expect(info.error).toMatch(/ended (?:[2-9]|\d{2,}) processes/);

      // nothing of git's still holds the folder
      const returned = Date.now();
      let freedAfter = -1;
      while (Date.now() - returned < 2000) {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
          freedAfter = Date.now() - returned;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(freedAfter).toBeGreaterThanOrEqual(0);
    },
  );

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

  // A repository delivered with its .git/ (an archive, a shared folder) can carry config and hooks
  // that git runs on its own (measured: core.fsmonitor on status and stash create, the
  // reference-transaction hook on update-ref). Git Guard's plumbing must not run them.
  const markerScript = (dir: string, name: string): string => {
    const marker = path.join(dir, `${name}.marker`).replace(/\\/g, '/');
    const script = path.join(dir, '.git', `${name}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\ncat >/dev/null\n`, { mode: 0o755 });
    return script.replace(/\\/g, '/');
  };

  it('TC-S20: Git Guard never runs a core.fsmonitor command the repository configures', () => {
    initRepo(tmpRoot);
    git(tmpRoot, ['config', 'core.fsmonitor', markerScript(tmpRoot, 'fsmonitor')]);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 2;\n', 'utf8');

    expect(getGitInfo(tmpRoot).isDirty).toBe(true);
    expect(createCheckpoint(tmpRoot, 'task-fsmonitor', 'best_effort').isStashSnapshot).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'fsmonitor.marker'))).toBe(false);
  });

  it('TC-S20b: Git Guard never runs the repository\'s hooks (reference-transaction on update-ref)', () => {
    initRepo(tmpRoot);
    fs.copyFileSync(
      markerScript(tmpRoot, 'reftx'),
      path.join(tmpRoot, '.git', 'hooks', 'reference-transaction'),
    );
    fs.chmodSync(path.join(tmpRoot, '.git', 'hooks', 'reference-transaction'), 0o755);
    fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 3;\n', 'utf8');

    const cp = createCheckpoint(tmpRoot, 'task-hooks', 'best_effort');
    expect(cp.isStashSnapshot).toBe(true);
    expect(git(tmpRoot, ['rev-parse', 'refs/ag-bridge/checkpoints/task-hooks'])).toBe(cp.checkpointRef);
    expect(fs.existsSync(path.join(tmpRoot, 'reftx.marker'))).toBe(false);
  });

  it('TC-S20c: a rollback in a partial clone never runs the repository\'s transport command (lazy fetch)', () => {
    // A partial clone fetches missing blobs on demand from its promisor remote; the repository's
    // config picks that remote and core.sshCommand (Grok leg; measured: `reset --hard` ran it).
    const seed = path.join(tmpRoot, 'seed');
    fs.mkdirSync(seed);
    initRepo(seed);
    const oldRev = git(seed, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(seed, 'app.ts'), 'export const version = 2;\n', 'utf8');
    git(seed, ['commit', '-qam', 'v2']);
    const bare = path.join(tmpRoot, 'server.git');
    git(tmpRoot, ['clone', '-q', '--bare', seed, bare]);
    git(bare, ['config', 'uploadpack.allowFilter', 'true']);
    const clone = path.join(tmpRoot, 'clone');
    git(tmpRoot, ['clone', '-q', '--filter=blob:none', `file://${bare.replace(/\\/g, '/')}`, clone]);
    git(clone, ['config', 'remote.origin.url', 'ssh://example.invalid/repo.git']);
    // The fake ssh must not read stdin: git keeps the transport pipe open, so `cat` would deadlock.
    const sshMarker = path.join(clone, 'ssh.marker').replace(/\\/g, '/');
    const fakeSsh = path.join(clone, '.git', 'fake-ssh.sh');
    fs.writeFileSync(fakeSsh, `#!/bin/sh\necho ran >> "${sshMarker}"\nexit 1\n`, { mode: 0o755 });
    git(clone, ['config', 'core.sshCommand', fakeSsh.replace(/\\/g, '/')]);

    const manifest: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'task-lazy',
      title: 'Lazy fetch rollback',
      mode: 'api',
      status: 'VERIFIED',
      lockedPaths: ['app.ts'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: oldRev, // its app.ts blob is not in the partial clone
      gitCheckpointIsStash: false,
      gitUntrackedBaseline: [],
      artifacts: [],
    };
    try {
      rollbackCheckpoint(clone, manifest);
    } catch {
      // the missing blob cannot be fetched: the rollback fails closed
    }
    expect(fs.existsSync(path.join(clone, 'ssh.marker'))).toBe(false);
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

  it('TC-U34c: rollbackCheckpoint surfaces timeout error instead of misreporting non-git workspace', { timeout: 60_000 }, () => {
    stallingFilter();
    const head = git(tmpRoot, ['rev-parse', 'HEAD']);
    const manifest: BridgeManifest = {
      schemaVersion: 1,
      taskId: 'task-rb-timeout',
      title: 'Rollback timeout error check',
      mode: 'api',
      status: 'FAILED',
      lockedPaths: ['app.ts'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gitCheckpointRef: head,
      gitCheckpointIsStash: false,
      gitUntrackedBaseline: [],
      artifacts: [],
    };
    process.env.AG_GIT_TIMEOUT_MS = '1000';
    try {
      expect(() => rollbackCheckpoint(tmpRoot, manifest)).toThrow(/Git did not answer within 1000 ms/);
    } finally {
      delete process.env.AG_GIT_TIMEOUT_MS;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'TC-U34d: on POSIX the time limit kills filter children left in git\'s isolated process group',
    { timeout: 30_000 },
    async () => {
      initRepo(tmpRoot);
      const pidFile = path.join(tmpRoot, '.git', 'filter.pid');
      const filterScript = path.join(tmpRoot, '.git', 'stall-posix.sh');
      fs.writeFileSync(
        filterScript,
        `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 8\ncat\n`,
        { mode: 0o755 },
      );
      git(tmpRoot, ['config', 'filter.slow.clean', filterScript]);
      fs.writeFileSync(path.join(tmpRoot, '.gitattributes'), 'app.ts filter=slow\n', 'utf8');
      git(tmpRoot, ['add', '.gitattributes']);
      git(tmpRoot, ['commit', '-qm', 'add slow filter']);
      fs.writeFileSync(path.join(tmpRoot, 'app.ts'), 'export const version = 2;\n', 'utf8');

      process.env.AG_GIT_TIMEOUT_MS = '1000';
      let info: ReturnType<typeof getGitInfo>;
      try {
        info = getGitInfo(tmpRoot);
      } finally {
        delete process.env.AG_GIT_TIMEOUT_MS;
      }

      expect(info.isGitRepo).toBe(false);
      expect(info.error).toMatch(/Git did not answer within 1000 ms/);
      expect(info.error).toMatch(/ended \d+ process/);

      // The clean filter shell recorded its PID before sleeping; it must already be gone.
      expect(fs.existsSync(pidFile)).toBe(true);
      const filterPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(filterPid) && filterPid > 1).toBe(true);

      let alive = true;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          process.kill(filterPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
            alive = false;
            break;
          }
          throw err;
        }
      }
      expect(alive).toBe(false);
    },
  );

  it('TC-U34e: endPosixLeftovers guards unsafe pgids, skips empty or self-containing groups, and SIGKILLs live groups', () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const recordKill = (pid: number, signal?: NodeJS.Signals | number): boolean => {
      calls.push({ pid, signal });
      return true;
    };

    // Unsafe pgids never trigger kill
    expect(endPosixLeftovers(0, recordKill, () => ({ members: 2, includesSelf: false }))).toBe(0);
    expect(endPosixLeftovers(1, recordKill, () => ({ members: 2, includesSelf: false }))).toBe(0);
    expect(endPosixLeftovers(-42, recordKill, () => ({ members: 2, includesSelf: false }))).toBe(0);
    expect(endPosixLeftovers(process.pid, recordKill, () => ({ members: 2, includesSelf: false }))).toBe(0);
    // Group that includes the current MCP server process is never signaled
    expect(endPosixLeftovers(42423, recordKill, () => ({ members: 2, includesSelf: true }))).toBe(0);
    expect(calls).toEqual([]);

    // Empty process group (ESRCH on probe) returns 0 without SIGKILL
    const esrchKill = (pid: number, signal?: NodeJS.Signals | number): boolean => {
      calls.push({ pid, signal });
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    expect(endPosixLeftovers(42424, esrchKill, () => ({ members: 0, includesSelf: false }))).toBe(0);
    expect(calls).toEqual([{ pid: -42424, signal: 0 }]);

    // Live process group with 2 initial members + 1 late spawn receives SIGKILL twice and reports 3
    calls.length = 0;
    let scanPass = 0;
    const scanSeq = () => (scanPass++ === 0 ? { members: 2, includesSelf: false } : { members: 1, includesSelf: false });
    expect(endPosixLeftovers(42425, recordKill, scanSeq)).toBe(3);
    expect(calls).toEqual([
      { pid: -42425, signal: 0 },
      { pid: -42425, signal: 'SIGKILL' },
      { pid: -42425, signal: 'SIGKILL' },
    ]);
  });

  it('TC-U45: createTaskWorktree isolates edits on ag-task/<id> while keeping parent clean, and removeTaskWorktree cleans up', () => {
    initRepo(tmpRoot);
    const wt = createTaskWorktree(tmpRoot, 'ag-wt-1');
    expect(wt.branchName).toBe('ag-task/ag-wt-1');
    expect(fs.existsSync(path.join(wt.worktreePath, 'app.ts'))).toBe(true);

    // Edit inside the isolated worktree must not dirty the parent workspace
    fs.writeFileSync(path.join(wt.worktreePath, 'app.ts'), 'export const version = 777;\n', 'utf8');
    expect(fs.readFileSync(path.join(tmpRoot, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');
    expect(git(wt.worktreePath, ['symbolic-ref', '--short', 'HEAD'])).toBe('ag-task/ag-wt-1');

    const rm = removeTaskWorktree(tmpRoot, wt.worktreePath, wt.branchName, true);
    expect(rm.removed).toBe(true);
    expect(rm.branchDeleted).toBe(true);
    expect(fs.existsSync(wt.worktreePath)).toBe(false);
    expect(git(tmpRoot, ['branch', '--list', wt.branchName])).toBe('');
  });

  it('TC-S27: removeTaskWorktree blocks paths outside .ag-bridge/worktrees/ and refuses deleting non-ag-task branches', () => {
    initRepo(tmpRoot);
    const mainBranch = git(tmpRoot, ['symbolic-ref', '--short', 'HEAD']);
    const outsideDir = path.join(tmpRoot, 'important-dir');
    fs.mkdirSync(outsideDir, { recursive: true });

    expect(() => removeTaskWorktree(tmpRoot, outsideDir, 'ag-task/fake', true)).toThrow(AgPluginError);
    expect(() => removeTaskWorktree(tmpRoot, path.join(tmpRoot, '.ag-bridge', 'worktrees', '..', 'history'), 'ag-task/fake', true)).toThrow(AgPluginError);
    expect(fs.existsSync(outsideDir)).toBe(true);

    // Tampered manifest naming the user's main branch must never delete it
    const wt = createTaskWorktree(tmpRoot, 'ag-wt-branch-guard');
    const rm = removeTaskWorktree(tmpRoot, wt.worktreePath, mainBranch, true);
    expect(rm.removed).toBe(true);
    expect(rm.branchDeleted).toBe(false);
    expect(rm.warning).toContain('Refused to delete branch');
    expect(git(tmpRoot, ['branch', '--list', mainBranch])).toContain(mainBranch);
    // Clean up the actual task branch
    git(tmpRoot, ['branch', '-D', wt.branchName]);
  });
});
