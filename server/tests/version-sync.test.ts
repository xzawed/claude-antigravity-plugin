import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVersionSync } from '../scripts/check-version-sync.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

function writeFixtureRepo(root: string, versions: {
  plugin?: string;
  pkg?: string;
  lockRoot?: string;
  lockPkg?: string;
  index?: string;
  spec?: string;
}): void {
  const v = {
    plugin: versions.plugin ?? '1.5.0',
    pkg: versions.pkg ?? '1.5.0',
    lockRoot: versions.lockRoot ?? '1.5.0',
    lockPkg: versions.lockPkg ?? '1.5.0',
    index: versions.index ?? '1.5.0',
    spec: versions.spec ?? '1.5.0',
  };

  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'antigravity-delegate', version: v.plugin }, null, 2),
  );

  fs.mkdirSync(path.join(root, 'server', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'server', 'package.json'),
    JSON.stringify({ name: 'claude-antigravity-plugin-server', version: v.pkg }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, 'server', 'package-lock.json'),
    JSON.stringify(
      {
        name: 'claude-antigravity-plugin-server',
        version: v.lockRoot,
        packages: { '': { version: v.lockPkg } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'server', 'src', 'index.ts'),
    `export function create() {\n  return new McpServer({\n    name: 'antigravity-delegate',\n    version: '${v.index}',\n  });\n}\n`,
  );

  fs.mkdirSync(path.join(root, 'docs', '03-specs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', '03-specs', 'mcp-tools-api.md'),
    `## 1. MCP 서버\n- **서버 이름:** \`antigravity-delegate\`\n- **버전:** \`${v.spec}\`\n`,
  );
}

describe('version sync gate (TC-U43)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-versionsync-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-U43: passes on this repository and matches the canonical tag', () => {
    const res = checkVersionSync(pluginRoot);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.sources.length).toBeGreaterThanOrEqual(5);

    const withTag = checkVersionSync(pluginRoot, { expectedTag: `v${res.version}` });
    expect(withTag.ok).toBe(true);
  });

  it('TC-U43b: rejects drift in any manifest, lockfile, server code, spec, or release tag', () => {
    writeFixtureRepo(tmpRoot, { index: '1.4.9' });
    const drift = checkVersionSync(tmpRoot);
    expect(drift.ok).toBe(false);
    expect(drift.errors.some((e: string) => e.includes('server/src/index.ts'))).toBe(true);

    writeFixtureRepo(tmpRoot, { spec: '1.4.0' });
    const specDrift = checkVersionSync(tmpRoot);
    expect(specDrift.ok).toBe(false);
    expect(specDrift.errors.some((e: string) => e.includes('mcp-tools-api.md'))).toBe(true);

    writeFixtureRepo(tmpRoot, {});
    const badTag = checkVersionSync(tmpRoot, { expectedTag: 'v2.0.0' });
    expect(badTag.ok).toBe(false);
    expect(badTag.errors.some((e: string) => e.includes('v2.0.0'))).toBe(true);

    const invalidTag = checkVersionSync(tmpRoot, { expectedTag: 'release-1.5.0' });
    expect(invalidTag.ok).toBe(false);
  });
});
