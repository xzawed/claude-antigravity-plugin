import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifest, writeManifest, writeReportMarkdown } from '../src/bridge-fs.js';
import { handleListArtifacts } from '../src/artifacts.js';
import { DetectorDeps } from '../src/detector.js';
import { ExecutionContext, ExecutionEngine, ExecutionResult } from '../src/engines/base.js';
import { attachStreamJsonHeartbeat, buildHandoffPrompt } from '../src/engines/subscription.js';
import {
  BackgroundJobManager,
  handleCancelAgJob,
  handleGetAgJob,
  handleStartAgTask,
} from '../src/jobs.js';
import { handleRollbackAgTask } from '../src/index.js';
import { DEFAULT_BRIDGE_CONFIG } from '../src/types.js';

function makeAgyDetectorDeps(): DetectorDeps {
  return {
    platform: 'linux',
    env: {},
    homedir: '/tmp/nonexistent-home',
    existsSync: (p) => p === '/usr/local/bin/agy',
    findBinary: (bin) => (bin === 'agy' ? '/usr/local/bin/agy' : undefined),
  };
}

describe('Async background jobs & power prompt parity (TC-U22 ~ TC-U26)', () => {
  let tmpRoot: string;
  let manager: BackgroundJobManager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-jobs-test-'));
    manager = new BackgroundJobManager();
  });

  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-S19c: start_ag_task reports the settings it ignored from a config git tracks', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpRoot, '.ag-bridge'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.ag-bridge', 'config.json'), JSON.stringify({ subscription: { agy_sandbox: false } }));
    execFileSync('git', ['add', '-f', '.ag-bridge/config.json'], { cwd: tmpRoot, stdio: 'ignore' });

    const quickEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(): Promise<ExecutionResult> {
        return { status: 'VERIFIED', reportMarkdown: '# Done', changedFiles: [], artifacts: [], warnings: [] };
      },
    };
    const started = await handleStartAgTask(
      { title: 'Trust check', instructions: 'Change nothing.', workspaceRoot: tmpRoot, modeOverride: 'subscription' },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: quickEngine, jobManager: manager },
    );
    expect(started.warnings.join('\n')).toContain('subscription.agy_sandbox');
  });

  it('TC-U22: start_ag_task returns immediately while engine runs in background and get_ag_job collects VERIFIED result + structuredOutput', async () => {
    let releaseEngine!: () => void;
    const gate = new Promise<void>((r) => {
      releaseEngine = r;
    });

    const mockEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        await gate;
        return {
          status: 'VERIFIED',
          reportMarkdown: '# Review Complete\nAll clean.',
          structuredOutput: { verdict: 'approve', findings: [] },
          changedFiles: ['src/App.tsx'],
          artifacts: [],
          metrics: {
            model: 'gemini-4-neon-high',
            conversationId: 'conv-bg-001',
            durationSeconds: 3.2,
            numTurns: 2,
            usage: {
              inputTokens: 1500,
              outputTokens: 120,
              thinkingTokens: 50,
              cacheReadTokens: 400,
              totalTokens: 1670,
            },
          },
          warnings: [],
        };
      },
    };

    const started = await handleStartAgTask(
      {
        title: 'Background UI audit',
        instructions: 'Audit dashboard components',
        workspaceRoot: tmpRoot,
        modeOverride: 'subscription',
      },
      {
        detectorDeps: makeAgyDetectorDeps(),
        subscriptionEngine: mockEngine,
        jobManager: manager,
      },
    );

    expect(started.ok).toBe(true);
    expect(started.status).toBe('RUNNING');
    expect(started.jobId).toBe(started.taskId);

    // Inspect while RUNNING
    const liveStatus = await handleGetAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );
    expect(liveStatus.ok).toBe(true);
    expect(liveStatus.activeCount).toBe(1);
    expect(liveStatus.job?.status).toBe('RUNNING');
    expect(liveStatus.job?.active).toBe(true);

    // List mode shows the active job
    const listed = await handleGetAgJob({ workspaceRoot: tmpRoot }, { jobManager: manager });
    expect(listed.ok).toBe(true);
    expect(listed.activeCount).toBe(1);
    expect(listed.jobs?.some((j) => j.jobId === started.jobId)).toBe(true);

    // Complete background engine
    releaseEngine();
    await new Promise((r) => setTimeout(r, 30));

    const doneStatus = await handleGetAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );
    expect(doneStatus.ok).toBe(true);
    expect(doneStatus.activeCount).toBe(0);
    expect(doneStatus.job?.status).toBe('VERIFIED');
    expect(doneStatus.job?.active).toBe(false);
    expect(doneStatus.job?.conversationId).toBe('conv-bg-001');
    expect(doneStatus.job?.structuredOutput).toEqual({ verdict: 'approve', findings: [] });
    expect(doneStatus.job?.reportMarkdown).toContain('Review Complete');
    expect(doneStatus.job?.metrics?.usage?.totalTokens).toBe(1670);
  });

  it('TC-U23: cancel_ag_job aborts running background job via AbortSignal and marks manifest FAILED(TASK_CANCELLED)', async () => {
    let abortObserved = false;
    const hangingEngine: ExecutionEngine = {
      mode: 'subscription',
      execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        return new Promise((resolve) => {
          ctx.abortSignal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              resolve({
                status: 'FAILED',
                reportMarkdown: 'Cancelled',
                changedFiles: [],
                artifacts: [],
                warnings: [],
                errorCode: 'TASK_CANCELLED',
                errorMessage: 'Cancelled via AbortSignal',
              });
            },
            { once: true },
          );
        });
      },
    };

    const started = await handleStartAgTask(
      {
        title: 'Long running swarm',
        instructions: '/swarm Refactor entire UI',
        workspaceRoot: tmpRoot,
        modeOverride: 'subscription',
      },
      {
        detectorDeps: makeAgyDetectorDeps(),
        subscriptionEngine: hangingEngine,
        jobManager: manager,
      },
    );

    const cancelled = await handleCancelAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );

    expect(abortObserved).toBe(true);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.jobId).toBe(started.jobId);
    expect(manager.activeCount(tmpRoot)).toBe(0);

    const manifest = readManifest(tmpRoot);
    expect(manifest?.status).toBe('FAILED');
    expect(manifest?.errorCode).toBe('TASK_CANCELLED');

    // Second cancel reports NOT_RUNNING cleanly
    const second = await handleCancelAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );
    expect(second.ok).toBe(true);
    expect(second.status).toBe('NOT_RUNNING');
  });

  it('TC-U24: start_ag_task enforces Fail-Closed lockedPaths before provider detection', async () => {
    await expect(
      handleStartAgTask(
        {
          title: 'Attempt secret edit',
          instructions: 'Edit env file',
          lockedPaths: ['.env'],
          workspaceRoot: tmpRoot,
        },
        {
          detectorDeps: {
            platform: 'linux',
            env: {},
            homedir: '/tmp/nonexistent',
            existsSync: () => false,
            findBinary: () => undefined,
          },
          jobManager: manager,
        },
      ),
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH_BLOCKED' });
  });

  it('TC-U25: buildHandoffPrompt preserves native /boost, /browser, /swarm, /goal slash commands and rawPrompt verbatim', () => {
    const baseCtx: ExecutionContext = {
      workspaceRoot: tmpRoot,
      pluginRoot: tmpRoot,
      manifest: {
        schemaVersion: 1,
        taskId: 'ag-test-prompt',
        title: 'Test',
        mode: 'subscription',
        status: 'DISPATCHED',
        lockedPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: [],
      },
      config: DEFAULT_BRIDGE_CONFIG,
      instructions: '/boost Analyze race conditions in jobs.ts',
      acceptanceCriteria: [],
      detection: {
        configuredMode: 'auto',
        resolvedMode: 'subscription',
        platform: 'linux',
        subscription: { detected: true, cliBinary: 'agy', cliPath: '/usr/bin/agy', triggerMethod: 'cli_or_ipc' },
        api: { configured: false, source: 'none', envVarName: 'GEMINI_API_KEY', model: 'gemini-2.5-pro', maxTurns: 15 },
        recommendations: [],
      },
    };

    expect(buildHandoffPrompt(baseCtx)).toBe('/boost Analyze race conditions in jobs.ts');
    expect(
      buildHandoffPrompt({ ...baseCtx, instructions: '/browser Open http://localhost:3000' }),
    ).toBe('/browser Open http://localhost:3000');
    expect(
      buildHandoffPrompt({ ...baseCtx, instructions: '/swarm Refactor modules' }),
    ).toBe('/swarm Refactor modules');
    expect(
      buildHandoffPrompt({ ...baseCtx, instructions: '/goal Make all tests pass' }),
    ).toBe('/goal Make all tests pass');
    expect(
      buildHandoffPrompt({
        ...baseCtx,
        instructions: 'Review diff',
        agyOptions: { agyMode: 'plan', jsonSchema: '{"type":"object"}' },
      }),
    ).toContain('Review diff');
    expect(
      buildHandoffPrompt({
        ...baseCtx,
        instructions: 'Normal UI build task',
      }),
    ).toContain('/claude-handoff');
  });

  it('TC-U26: attachStreamJsonHeartbeat captures structured_output from agy --json-schema result event', async () => {
    const stream = new PassThrough();
    const handle = attachStreamJsonHeartbeat(stream, {
      workspaceRoot: tmpRoot,
      taskId: 'ag-structured-1',
      autoFinalizeOnResult: false,
    });

    stream.write(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-json-1',
          status: 'SUCCESS',
          response: '{"verdict":"approve","findings":[]}',
          structured_output: { verdict: 'approve', findings: [] },
          duration_seconds: 2.1,
          num_turns: 1,
          usage: {
            input_tokens: 500,
            output_tokens: 20,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 520,
          },
        },
      }) + '\n',
    );
    stream.end();

    await new Promise((r) => setTimeout(r, 20));
    expect(handle.state.structuredOutput).toEqual({ verdict: 'approve', findings: [] });
    expect(handle.state.metrics.usage?.totalTokens).toBe(520);
    handle.stop();
  });

  it('TC-U39: start_ag_task clears stale report.md and get_ag_job masks secrets & isolates report per taskId', async () => {
    // Task 1 left a stale report.md behind
    writeReportMarkdown(tmpRoot, '# Stale Report from Task 1\nOld output.');

    let releaseEngine!: () => void;
    const gate = new Promise<void>((r) => {
      releaseEngine = r;
    });
    const fakeSecret = ['AIza', 'SyLiveJobReportSecret1234567890abcd'].join('');

    const mockEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(): Promise<ExecutionResult> {
        await gate;
        return {
          status: 'VERIFIED',
          reportMarkdown: '# Task 2 Final Report',
          changedFiles: [],
          artifacts: [],
          warnings: [],
        };
      },
    };

    const started = await handleStartAgTask(
      {
        title: 'Second background task',
        instructions: '/boost Fresh run',
        workspaceRoot: tmpRoot,
        modeOverride: 'subscription',
      },
      {
        detectorDeps: makeAgyDetectorDeps(),
        subscriptionEngine: mockEngine,
        jobManager: manager,
      },
    );

    // Stale Task 1 report must have been cleared on dispatch
    const duringRun = await handleGetAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );
    expect(duringRun.job?.reportMarkdown).toBeUndefined();

    // If Task 2 writes an interim report.md containing a secret, get_ag_job must mask it
    writeReportMarkdown(tmpRoot, `# Interim\nkey=${fakeSecret}`);
    const maskedRun = await handleGetAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot },
      { jobManager: manager },
    );
    expect(maskedRun.job?.reportMarkdown).toContain('[REDACTED]');
    expect(maskedRun.job?.reportMarkdown).not.toContain(fakeSecret);

    releaseEngine();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('TC-U45b: runs two concurrent isolateWorktree start_ag_task jobs in parallel without BRIDGE_BUSY', async () => {
    const runGitCmd = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    runGitCmd(['init']);
    runGitCmd(['config', 'user.email', 'par@example.com']);
    runGitCmd(['config', 'user.name', 'Par User']);
    runGitCmd(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(tmpRoot, 'shared.ts'), 'export const base = 0;\n', 'utf8');
    runGitCmd(['add', 'shared.ts']);
    runGitCmd(['commit', '-m', 'init']);

    let releaseBoth!: () => void;
    const gate = new Promise<void>((r) => {
      releaseBoth = r;
    });
    const seenRoots: string[] = [];

    const mockEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        seenRoots.push(ctx.workspaceRoot);
        await gate;
        const markerFile = `${ctx.manifest.taskId}.txt`;
        fs.writeFileSync(path.join(ctx.workspaceRoot, markerFile), ctx.manifest.title, 'utf8');
        return {
          status: 'VERIFIED',
          reportMarkdown: `# Done ${ctx.manifest.title}`,
          changedFiles: [markerFile],
          artifacts: [],
          warnings: [],
        };
      },
    };

    const manager = new BackgroundJobManager();
    const job1 = await handleStartAgTask(
      {
        title: 'Parallel UI Task A',
        instructions: 'Build card component in worktree A.',
        isolateWorktree: true,
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: mockEngine, jobManager: manager },
    );

    const job2 = await handleStartAgTask(
      {
        title: 'Parallel UI Task B',
        instructions: 'Build modal component in worktree B.',
        isolateWorktree: true,
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: mockEngine, jobManager: manager },
    );

    expect(job1.ok).toBe(true);
    expect(job2.ok).toBe(true);
    expect(job1.worktreePath).toBeTruthy();
    expect(job2.worktreePath).toBeTruthy();
    expect(job1.worktreePath).not.toBe(job2.worktreePath);
    expect(job1.worktreeBranch).toBe(`ag-task/${job1.taskId}`);
    expect(job2.worktreeBranch).toBe(`ag-task/${job2.taskId}`);

    const listing = await handleGetAgJob({ workspaceRoot: tmpRoot }, { jobManager: manager });
    expect(listing.activeCount).toBe(2);

    releaseBoth();
    await new Promise((r) => setTimeout(r, 80));

    const res1 = await handleGetAgJob({ jobId: job1.jobId, workspaceRoot: tmpRoot }, { jobManager: manager });
    const res2 = await handleGetAgJob({ jobId: job2.jobId, workspaceRoot: tmpRoot }, { jobManager: manager });
    expect(res1.job?.status).toBe('VERIFIED');
    expect(res2.job?.status).toBe('VERIFIED');
    expect(res1.job?.worktreePath).toBe(job1.worktreePath);
    expect(res2.job?.worktreePath).toBe(job2.worktreePath);
    expect(seenRoots).toEqual([job1.worktreePath, job2.worktreePath]);

    // Parent workspace remains completely clean
    expect(runGitCmd(['status', '--porcelain'])).toBe('');

    // Clean up both worktrees via handleRollbackAgTask
    const rb1 = await handleRollbackAgTask({ taskId: job1.taskId, workspaceRoot: tmpRoot });
    const rb2 = await handleRollbackAgTask({ taskId: job2.taskId, workspaceRoot: tmpRoot });
    expect(rb1.worktreeRemoved).toBe(true);
    expect(rb1.worktreeBranchDeleted).toBe(true);
    expect(rb2.worktreeRemoved).toBe(true);
    expect(rb2.worktreeBranchDeleted).toBe(true);
    expect(fs.existsSync(job1.worktreePath!)).toBe(false);
    expect(fs.existsSync(job2.worktreePath!)).toBe(false);
  });

  it('TC-S37: rollback_ag_task refuses ambiguous omitted taskId after worktree run, blocks active worktree removal, and ignores tampered parent worktreePath', async () => {
    const runGitCmd = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    runGitCmd(['init']);
    runGitCmd(['config', 'user.email', 'sec@example.com']);
    runGitCmd(['config', 'user.name', 'Sec User']);
    runGitCmd(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(tmpRoot, 'main.ts'), 'export const v = 1;\n', 'utf8');
    runGitCmd(['add', 'main.ts']);
    runGitCmd(['commit', '-m', 'init']);

    let releaseWt!: () => void;
    const wtGate = new Promise<void>((r) => {
      releaseWt = r;
    });

    const quickEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        if (ctx.manifest.worktreePath) {
          await wtGate;
        } else {
          fs.writeFileSync(path.join(ctx.workspaceRoot, 'main.ts'), 'export const v = 2;\n', 'utf8');
        }
        return {
          status: 'VERIFIED',
          reportMarkdown: '# OK',
          changedFiles: [],
          artifacts: [],
          warnings: [],
        };
      },
    };

    // 1. Run a main-workspace task T1
    const mainJob = await handleStartAgTask(
      {
        title: 'Main task T1',
        instructions: 'Edit main.ts',
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: quickEngine, jobManager: manager },
    );
    await new Promise((r) => setTimeout(r, 50));

    // 2. Run an isolated worktree task T2 (newer than T1)
    const wtJob = await handleStartAgTask(
      {
        title: 'Worktree task T2',
        instructions: 'Run in isolated worktree',
        isolateWorktree: true,
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: quickEngine, jobManager: manager },
    );

    // 3. Attempting to remove the still-running worktree refuses with BRIDGE_BUSY
    await expect(
      handleRollbackAgTask({ taskId: wtJob.taskId, workspaceRoot: tmpRoot }, { jobManager: manager }),
    ).rejects.toMatchObject({ code: 'BRIDGE_BUSY' });

    releaseWt();
    await new Promise((r) => setTimeout(r, 60));

    // 4. Omitting taskId refuses instead of silently rolling back older main task T1
    await expect(
      handleRollbackAgTask({ workspaceRoot: tmpRoot }, { jobManager: manager }),
    ).rejects.toMatchObject({ code: 'ROLLBACK_NO_CHECKPOINT' });
    expect(fs.readFileSync(path.join(tmpRoot, 'main.ts'), 'utf8')).toBe('export const v = 2;\n');

    // 5. Tampered worktreePath inside parent manifest.json must NOT bypass main workspace rollback
    const parentManifest = readManifest(tmpRoot)!;
    writeManifest(tmpRoot, {
      ...parentManifest,
      worktreePath: wtJob.worktreePath,
      worktreeBranch: wtJob.worktreeBranch,
    });
    const rbMain = await handleRollbackAgTask({ taskId: mainJob.taskId, workspaceRoot: tmpRoot }, { jobManager: manager });
    expect(rbMain.ok).toBe(true);
    expect(rbMain.worktreeRemoved).toBeUndefined();
    expect(fs.readFileSync(path.join(tmpRoot, 'main.ts'), 'utf8')).toBe('export const v = 1;\n');
    expect(fs.existsSync(wtJob.worktreePath!)).toBe(true);

    // 6. Explicit rollback of T2 cleanly removes worktree
    const rbWt = await handleRollbackAgTask({ taskId: wtJob.taskId, workspaceRoot: tmpRoot }, { jobManager: manager });
    expect(rbWt.ok).toBe(true);
    expect(rbWt.worktreeRemoved).toBe(true);
    expect(rbWt.worktreeBranchDeleted).toBe(true);
  });

  it('TC-U48: isolateWorktree supports absolute lockedPaths and exposes report, artifacts, and logTail via disk fallback and list_ag_artifacts', async () => {
    const runGitCmd = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    runGitCmd(['init']);
    runGitCmd(['config', 'user.email', 'art@example.com']);
    runGitCmd(['config', 'user.name', 'Art User']);
    runGitCmd(['config', 'core.autocrlf', 'false']);
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'ui.ts'), 'export const ui = 1;\n', 'utf8');
    runGitCmd(['add', 'src/ui.ts']);
    runGitCmd(['commit', '-m', 'init']);

    const mockEngine: ExecutionEngine = {
      mode: 'subscription',
      async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        const artDir = path.join(ctx.workspaceRoot, '.ag-bridge', 'artifacts', ctx.manifest.taskId);
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, 'agy-cli.log'), 'line1\nworktree-log-tail\n', 'utf8');
        fs.writeFileSync(path.join(artDir, 'shot.png'), 'pngbytes', 'utf8');
        writeReportMarkdown(ctx.workspaceRoot, '# Worktree Verification Report\nAll passed.');
        return {
          status: 'VERIFIED',
          reportMarkdown: '# Worktree Verification Report\nAll passed.',
          changedFiles: ['src/ui.ts'],
          artifacts: [`.ag-bridge/artifacts/${ctx.manifest.taskId}/shot.png`],
          warnings: [],
        };
      },
    };

    // Absolute lockedPath inside parent workspace must normalize and re-validate cleanly inside worktree
    const absLocked = path.join(tmpRoot, 'src', 'ui.ts');
    const started = await handleStartAgTask(
      {
        title: 'Worktree artifact check',
        instructions: 'Verify UI in worktree',
        lockedPaths: [absLocked],
        isolateWorktree: true,
        modeOverride: 'subscription',
        workspaceRoot: tmpRoot,
      },
      { detectorDeps: makeAgyDetectorDeps(), subscriptionEngine: mockEngine, jobManager: manager },
    );
    await new Promise((r) => setTimeout(r, 80));

    // Fresh manager simulates MCP server restart -> disk fallback must read from worktree
    const freshManager = new BackgroundJobManager();
    const diskJob = await handleGetAgJob(
      { jobId: started.jobId, workspaceRoot: tmpRoot, includeLogTail: true },
      { jobManager: freshManager },
    );
    expect(diskJob.ok).toBe(true);
    expect(diskJob.job?.status).toBe('VERIFIED');
    expect(diskJob.job?.reportMarkdown).toContain('Worktree Verification Report');
    expect(diskJob.job?.logTail).toContain('worktree-log-tail');
    expect(diskJob.job?.artifacts?.some((a) => a.includes('shot.png'))).toBe(true);

    // list_ag_artifacts also discovers worktree artifacts, report, and logTail
    const listed = handleListArtifacts({ taskId: started.taskId, workspaceRoot: tmpRoot });
    expect(listed.ok).toBe(true);
    expect(listed.artifacts.some((a) => a.name === 'shot.png')).toBe(true);
    expect(listed.reportMarkdown).toContain('Worktree Verification Report');
    expect(listed.logTail).toContain('worktree-log-tail');

    // Clean up
    const rb = await handleRollbackAgTask({ taskId: started.taskId, workspaceRoot: tmpRoot }, { jobManager: freshManager });
    expect(rb.ok).toBe(true);
    expect(rb.worktreeRemoved).toBe(true);
  });
});
