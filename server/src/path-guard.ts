import fs from 'node:fs';
import path from 'node:path';
import { AgPluginError } from './types.js';

const IS_WINDOWS = process.platform === 'win32';

function normalizeForComparison(p: string): string {
  const normalized = path.resolve(p);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

function toPosixRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(workspaceRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rootCmp = normalizeForComparison(rootPath);
  const candCmp = normalizeForComparison(candidatePath);
  if (candCmp === rootCmp) {
    return true;
  }
  const prefix = rootCmp.endsWith(path.sep) ? rootCmp : rootCmp + path.sep;
  return candCmp.startsWith(prefix);
}

const MAX_SYMLINK_HOPS = 40;

/**
 * The OS's real path (`fs.realpathSync.native`) of `targetPath`, or of its nearest existing parent
 * with the rest appended — ALSO following dangling symbolic links (so a repo-committed dangling
 * symlink like `src/hook -> ../.git/hooks/post-checkout` or `src/out -> /etc/pwned` resolves to
 * its actual target and is caught by containment / denylist checks instead of bypassing them).
 * Non-ENOENT/ENOTDIR stat errors fail closed.
 */
export function nativeRealPathOrNearestParent(targetPath: string, depth = 0): string {
  if (depth > MAX_SYMLINK_HOPS) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Path "${targetPath}" exceeded maximum symbolic link depth (${MAX_SYMLINK_HOPS}).`,
    );
  }
  let current = path.resolve(targetPath);
  const trailingSegments: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return trailingSegments.length > 0 ? path.join(real, ...trailingSegments) : real;
    } catch {
      let lstat: fs.Stats | null = null;
      try {
        lstat = fs.lstatSync(current);
      } catch (lstatErr) {
        const code = (lstatErr as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new AgPluginError(
            'PATH_TRAVERSAL_BLOCKED',
            `Cannot safely inspect path "${current}" (${code ?? 'unknown error'}).`,
          );
        }
      }

      if (lstat?.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(current);
        const resolvedLink = path.resolve(path.dirname(current), linkTarget);
        const nextPath =
          trailingSegments.length > 0 ? path.join(resolvedLink, ...trailingSegments) : resolvedLink;
        return nativeRealPathOrNearestParent(nextPath, depth + 1);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(targetPath);
      }
      trailingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `candidatePath`, resolved through links and path aliases, lies inside `workspaceRoot`. */
export function isInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  return isInsideRoot(
    nativeRealPathOrNearestParent(workspaceRoot),
    nativeRealPathOrNearestParent(candidatePath),
  );
}

/**
 * Windows opens one file under spellings a string check misses: it strips a trailing dot or space
 * from a name, and `name:stream` opens an alternate data stream (`.env::$DATA` is .env's content —
 * measured). Such segments are refused outright (TC-S21b, TC-S21c).
 */
function assertNoWindowsAlias(posixRel: string, what: string): void {
  if (!IS_WINDOWS) {
    return;
  }
  for (const segment of posixRel.split('/')) {
    if (segment.includes(':') || /[. ]$/.test(segment)) {
      throw new AgPluginError(
        'PATH_TRAVERSAL_BLOCKED',
        `${what}: "${posixRel}" uses a Windows path alias (an alternate data stream, or a name ending in a dot or space).`,
      );
    }
  }
}

/** The workspace root as the OS names it (long names, real case). */
function realWorkspaceRoot(workspaceRoot: string): string {
  return fs.realpathSync.native(path.resolve(workspaceRoot));
}

function isEnvFileName(base: string): boolean {
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === '.envrc' ||
    base.startsWith('.env_') ||
    base.startsWith('.env-')
  );
}

function isProtectedWritePath(posixRel: string): boolean {
  const lower = posixRel.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  if (segments[0] === '.git' || segments.includes('.git')) {
    return true;
  }
  if (segments[0] === 'node_modules' || segments.includes('node_modules')) {
    return true;
  }
  if (lower === '.ag-bridge/config.json') {
    return true;
  }
  const base = segments[segments.length - 1];
  if (isEnvFileName(base)) {
    return true;
  }
  return false;
}

function isProtectedReadPath(posixRel: string): boolean {
  const lower = posixRel.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  if (segments.includes('.ssh')) {
    return true;
  }
  if (lower === '.ag-bridge/config.json') {
    return true;
  }
  const base = segments[segments.length - 1];
  if (isEnvFileName(base) && base !== '.env.example' && base !== '.env.sample') {
    return true;
  }
  if (base.endsWith('.pem') || base.endsWith('.key') || base === 'id_rsa' || base === 'id_ed25519') {
    return true;
  }
  return false;
}

export function validateLockedPathsConfig(workspaceRoot: string, lockedPaths: string[]): string[] {
  if (!Array.isArray(lockedPaths) || lockedPaths.length === 0) {
    throw new AgPluginError(
      'INVALID_LOCKED_PATHS',
      'lockedPaths must contain at least one relative file or directory path inside the workspace.',
    );
  }

  const realRoot = realWorkspaceRoot(workspaceRoot);
  const normalizedScopes: string[] = [];

  for (const rawScope of lockedPaths) {
    const scope = rawScope.trim();
    if (!scope || scope.includes('\0')) {
      throw new AgPluginError('INVALID_LOCKED_PATHS', `Invalid lockedPath entry: "${rawScope}"`);
    }

    const resolved = path.resolve(realRoot, scope);
    if (!isInsideRoot(realRoot, resolved)) {
      throw new AgPluginError(
        'INVALID_LOCKED_PATHS',
        `lockedPath "${scope}" resolves outside the workspace root.`,
      );
    }
    assertNoWindowsAlias(toPosixRelative(realRoot, resolved), 'lockedPath');

    const realScope = nativeRealPathOrNearestParent(resolved);
    if (!isInsideRoot(realRoot, realScope)) {
      throw new AgPluginError(
        'INVALID_LOCKED_PATHS',
        `lockedPath "${scope}" escapes the workspace via symlink.`,
      );
    }

    const rel = toPosixRelative(realRoot, realScope);
    if (isProtectedWritePath(rel)) {
      throw new AgPluginError(
        'PROTECTED_PATH_BLOCKED',
        `lockedPath "${scope}" targets a protected path (.git, .env*, node_modules, or .ag-bridge/config.json).`,
      );
    }

    normalizedScopes.push(rel);
  }

  return normalizedScopes;
}

export function assertWritablePath(
  workspaceRoot: string,
  targetPath: string,
  lockedPaths: string[],
): string {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.includes('\0')) {
    throw new AgPluginError('PATH_TRAVERSAL_BLOCKED', 'Target path is empty or contains null bytes.');
  }

  if (!Array.isArray(lockedPaths) || lockedPaths.length === 0) {
    throw new AgPluginError(
      'PATH_OUTSIDE_LOCKED_SCOPE',
      'Write denied: lockedPaths is empty (fail-closed policy).',
    );
  }

  const realRoot = realWorkspaceRoot(workspaceRoot);
  const resolvedTarget = path.resolve(realRoot, targetPath);

  if (!isInsideRoot(realRoot, resolvedTarget)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Write denied: "${targetPath}" resolves outside the workspace root.`,
    );
  }
  assertNoWindowsAlias(toPosixRelative(realRoot, resolvedTarget), 'Write denied');

  const realTarget = nativeRealPathOrNearestParent(resolvedTarget);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Write denied: "${targetPath}" escapes the workspace root via symlink.`,
    );
  }

  const relTarget = toPosixRelative(realRoot, realTarget);
  if (isProtectedWritePath(relTarget)) {
    throw new AgPluginError(
      'PROTECTED_PATH_BLOCKED',
      `Write denied: "${relTarget}" is a protected path and cannot be modified by delegated agents.`,
    );
  }

  const matchesScope = lockedPaths.some((scope) => {
    const trimmed = scope.trim();
    if (!trimmed || trimmed.includes('\0')) {
      return false;
    }
    const resolvedScope = path.resolve(realRoot, trimmed);
    if (!isInsideRoot(realRoot, resolvedScope)) {
      return false;
    }
    const realScope = nativeRealPathOrNearestParent(resolvedScope);
    if (!isInsideRoot(realRoot, realScope)) {
      return false;
    }

    const scopeCmp = normalizeForComparison(realScope);
    const targetCmp = normalizeForComparison(realTarget);
    if (targetCmp === scopeCmp) {
      return true;
    }
    const dirPrefix = scopeCmp.endsWith(path.sep) ? scopeCmp : scopeCmp + path.sep;
    return targetCmp.startsWith(dirPrefix);
  });

  if (!matchesScope) {
    throw new AgPluginError(
      'PATH_OUTSIDE_LOCKED_SCOPE',
      `Write denied: "${relTarget}" is outside allowed lockedPaths [${lockedPaths.join(', ')}].`,
    );
  }

  return realTarget;
}

export function assertReadablePath(workspaceRoot: string, targetPath: string): string {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.includes('\0')) {
    throw new AgPluginError('PATH_TRAVERSAL_BLOCKED', 'Target path is empty or contains null bytes.');
  }

  const realRoot = realWorkspaceRoot(workspaceRoot);
  const resolvedTarget = path.resolve(realRoot, targetPath);

  if (!isInsideRoot(realRoot, resolvedTarget)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Read denied: "${targetPath}" resolves outside the workspace root.`,
    );
  }
  assertNoWindowsAlias(toPosixRelative(realRoot, resolvedTarget), 'Read denied');

  const realTarget = nativeRealPathOrNearestParent(resolvedTarget);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new AgPluginError(
      'PATH_TRAVERSAL_BLOCKED',
      `Read denied: "${targetPath}" escapes the workspace root via symlink.`,
    );
  }

  const relTarget = toPosixRelative(realRoot, realTarget);
  if (isProtectedReadPath(relTarget)) {
    throw new AgPluginError(
      'PROTECTED_PATH_BLOCKED',
      `Read denied: "${relTarget}" is a protected secret file.`,
    );
  }

  return realTarget;
}
