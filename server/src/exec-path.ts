import fs from 'node:fs';
import path from 'node:path';

/**
 * Every program the plugin launches is resolved here to an absolute path first.
 *
 * A bare name handed to `spawn`/`execFileSync` is looked up on PATH, and a relative PATH entry —
 * ".", "bin", "node_modules\.bin", a drive-relative "C:tools", an empty POSIX entry — resolves
 * against the child's cwd, which for this plugin is the user's workspace. A same-named program the
 * opened repository ships would then run instead of the real one (measured on Windows, Node 22: a
 * planted git.exe ran once "." was on PATH). Only fully qualified PATH entries are searched here.
 * Rule and threat: docs/02-architecture/security-and-git-guard.md §6. Guard: TC-S12 ~ TC-S16.
 */

export interface ProgramLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether a candidate path is a program `spawn` can start; defaults to a filesystem probe. */
  isCandidate?: (candidate: string) => boolean;
}

/** Windows environment names are case-insensitive (`Path`, `ComSpec`); a copied env object is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** `X:\…` or `\\server\share\…` — not drive-relative (`C:tools`) or root-relative (`\tools`). */
function isFullyQualifiedWin32(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** What POSIX execvp searches when PATH is unset (`_PATH_DEFPATH`). Windows has no equivalent. */
const POSIX_DEFAULT_PATH = '/usr/bin:/bin';

/** PATH's fully qualified directories, in order. Relative and empty entries are dropped. */
export function absolutePathDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  // Unset PATH on POSIX: search what execvp would. Set-but-empty means "the cwd" there: nothing.
  const raw = envValue(env, 'PATH') ?? (platform === 'win32' ? '' : POSIX_DEFAULT_PATH);
  if (!raw) {
    return [];
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const qualified = platform === 'win32' ? isFullyQualifiedWin32 : (d: string) => path.posix.isAbsolute(d);
  return raw
    .split(pathApi.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter((d) => d.length > 0 && qualified(d));
}

/** A regular file — and, on POSIX, executable (execvp skips one it cannot run and keeps looking). */
function isSpawnableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      fs.accessSync(candidate, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `name` to the absolute path of a program `spawn` can start with `shell: false`.
 * On Windows only `name.com` / `name.exe` qualify — the extensions libuv itself tries for a bare
 * name; a `.cmd`/`.bat` needs a shell (spawn throws EINVAL for one since Node 20.12).
 */
export function resolveExecutable(name: string, lookup: ProgramLookup = {}): string | undefined {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const isCandidate = lookup.isCandidate ?? isSpawnableFile;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fileNames =
    platform === 'win32' && !/\.(com|exe)$/i.test(name) ? [`${name}.com`, `${name}.exe`] : [name];

  for (const dir of absolutePathDirs(platform, env)) {
    for (const fileName of fileNames) {
      const candidate = pathApi.join(dir, fileName);
      if (isCandidate(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** {@link resolveExecutable}, throwing where a bare spawn would have failed with ENOENT. */
export function requireExecutable(name: string, lookup?: ProgramLookup): string {
  const found = resolveExecutable(name, lookup);
  if (!found) {
    throw new Error(
      `"${name}" was not found in any absolute PATH directory (relative PATH entries are never searched).`,
    );
  }
  return found;
}

/**
 * The Windows command interpreter as an absolute path: `%ComSpec%` when fully qualified, else
 * `%SystemRoot%\System32\cmd.exe` (`C:\Windows` when SystemRoot is unusable). Node spawns
 * `ComSpec || 'cmd.exe'` for `shell: true`; that bare fallback is the PATH lookup avoided here.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = envValue(env, 'ComSpec')?.trim();
  if (comspec && isFullyQualifiedWin32(comspec)) {
    return comspec;
  }
  const root = envValue(env, 'SystemRoot')?.trim();
  return path.win32.join(root && isFullyQualifiedWin32(root) ? root : 'C:\\Windows', 'System32', 'cmd.exe');
}
