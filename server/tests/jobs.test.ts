import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifest, writeReportMarkdown } from '../src/bridge-fs.js';
import { DetectorDeps } from '../src/detector.js';
import { ExecutionContext, ExecutionEngine, ExecutionResult } from '../src/engines/base.js';
import { attachStreamJsonHeartbeat, buildHandoffPrompt } from '../src/engines/subscription.js';
import {
  BackgroundJobManager,
  handleCancelAgJob,
  handleGetAgJob,
  handleStartAgTask,
} from '../src/jobs.js';
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
});
