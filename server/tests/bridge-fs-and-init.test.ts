import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireBridgeLock,
  ensureGitignoreEntry,
  readArchivedManifest,
  writeManifest,
} from '../src/bridge-fs.js';
import { runCliInit } from '../src/cli-init.js';
import { AgPluginError, BridgeManifest } from '../src/types.js';

describe('bridge-fs & cli-init (TC-U04 ~ TC-U06, TC-U10)', () => {
  let tmpRoot: string;
  const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-U04: ensures .gitignore contains .ag-bridge/ idempotently', () => {
    const first = ensureGitignoreEntry(tmpRoot);
    expect(first.updated).toBe(true);
    expect(first.protected).toBe(true);

    const second = ensureGitignoreEntry(tmpRoot);
    expect(second.updated).toBe(false);
    expect(second.protected).toBe(true);

    const content = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    const occurrences = content.match(/\.ag-bridge\//g) ?? [];
    expect(occurrences.length).toBe(1);
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
    expect(res.gitignoreUpdated).toBe(true);
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
  });
});
