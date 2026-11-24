#!/usr/bin/env node
/**
 * Release & CI version consistency gate.
 *
 * Ensures every version declaration across the plugin manifests, server package/lockfile,
 * MCP server registration, and MCP API spec agrees — and, when `--tag vX.Y.Z` is provided
 * (for example by `.github/workflows/release.yml`), matches the Git release tag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readServerIndexVersion(indexPath) {
  const raw = fs.readFileSync(indexPath, 'utf8');
  const match = /new\s+McpServer\s*\(\s*\{[\s\S]*?version\s*:\s*['"]([^'"]+)['"]/.exec(raw);
  return match ? match[1] : null;
}

function readMcpSpecVersion(specPath) {
  const raw = fs.readFileSync(specPath, 'utf8');
  const match = /^-\s+\*\*버전:\*\*\s+`([^`]+)`/m.exec(raw);
  return match ? match[1] : null;
}

/**
 * Inspect version strings across the repository.
 * @param {string} repoRoot
 * @param {{ expectedTag?: string }} [options]
 */
export function checkVersionSync(repoRoot, options = {}) {
  const sources = [];
  const errors = [];

  const pluginJsonPath = path.join(repoRoot, '.claude-plugin', 'plugin.json');
  const serverPkgPath = path.join(repoRoot, 'server', 'package.json');
  const serverLockPath = path.join(repoRoot, 'server', 'package-lock.json');
  const serverIndexPath = path.join(repoRoot, 'server', 'src', 'index.ts');
  const mcpSpecPath = path.join(repoRoot, 'docs', '03-specs', 'mcp-tools-api.md');

  const record = (label, version) => {
    sources.push({ label, version });
    if (!version || typeof version !== 'string') {
      errors.push(`${label}: version missing or unreadable`);
    } else if (!SEMVER_RE.test(version)) {
      errors.push(`${label}: "${version}" is not valid semver`);
    }
  };

  const pluginJson = readJson(pluginJsonPath);
  record('.claude-plugin/plugin.json', pluginJson.version);

  const serverPkg = readJson(serverPkgPath);
  record('server/package.json', serverPkg.version);

  if (fs.existsSync(serverLockPath)) {
    const lockJson = readJson(serverLockPath);
    record('server/package-lock.json (root)', lockJson.version);
    const rootPkg = lockJson.packages && lockJson.packages[''];
    if (rootPkg) {
      record('server/package-lock.json (packages[""])', rootPkg.version);
    }
  }

  record('server/src/index.ts', readServerIndexVersion(serverIndexPath));
  record('docs/03-specs/mcp-tools-api.md', readMcpSpecVersion(mcpSpecPath));

  const canonical = sources[0]?.version ?? null;
  if (canonical) {
    for (const s of sources.slice(1)) {
      if (s.version && s.version !== canonical) {
        errors.push(`${s.label} declares "${s.version}", expected "${canonical}" (from ${sources[0].label})`);
      }
    }
  }

  const expectedTag = options.expectedTag?.trim();
  if (expectedTag) {
    const normalized = expectedTag.startsWith('refs/tags/')
      ? expectedTag.slice('refs/tags/'.length)
      : expectedTag;
    const expectedVersion = normalized.startsWith('v') ? normalized.slice(1) : null;
    if (!expectedVersion || !SEMVER_RE.test(expectedVersion)) {
      errors.push(`Tag "${normalized}" must match v<semver> (e.g. v1.5.0)`);
    } else if (canonical && expectedVersion !== canonical) {
      errors.push(`Tag "${normalized}" does not match repository version "${canonical}"`);
    }
  }

  return {
    ok: errors.length === 0,
    version: canonical,
    sources,
    errors,
  };
}

function parseCliTag(argv) {
  const idx = argv.indexOf('--tag');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const expectedTag = parseCliTag(process.argv.slice(2));
  const result = checkVersionSync(repoRoot, { expectedTag });

  if (!result.ok) {
    console.error('[version-sync] FAIL:');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const tagSuffix = expectedTag ? ` (matches tag ${expectedTag})` : '';
  console.log(
    `[version-sync] OK: ${result.sources.length} declarations agree on version ${result.version}${tagSuffix}`,
  );
}
