import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReadablePath,
  assertWritablePath,
  validateLockedPathsConfig,
} from '../src/path-guard.js';
import { AgPluginError } from '../src/types.js';

describe('path-guard security (TC-S01 ~ TC-S03)', () => {
  let tmpRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pathguard-ws-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pathguard-out-'));
    fs.mkdirSync(path.join(tmpRoot, 'src', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'server', 'secret.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SECRET=123');
    fs.writeFileSync(path.join(tmpRoot, '.env.example'), 'SECRET=');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('allows writes strictly within lockedPaths directory and exact file scopes', () => {
    const allowedDirFile = assertWritablePath(tmpRoot, 'src/ui/Button.tsx', ['src/ui/']);
    expect(allowedDirFile.endsWith(path.join('src', 'ui', 'Button.tsx'))).toBe(true);

    const exactFile = assertWritablePath(tmpRoot, 'src/ui/App.tsx', ['src/ui/App.tsx']);
    expect(exactFile.endsWith(path.join('src', 'ui', 'App.tsx'))).toBe(true);
  });

  it('TC-S01: blocks ../ path traversal outside lockedPaths and workspace root', () => {
    expect(() =>
      assertWritablePath(tmpRoot, 'src/ui/../../server/secret.ts', ['src/ui/']),
    ).toThrow(AgPluginError);

    try {
      assertWritablePath(tmpRoot, '../../../etc/passwd', ['src/ui/']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgPluginError);
      expect((err as AgPluginError).code).toBe('PATH_TRAVERSAL_BLOCKED');
    }

    try {
      assertWritablePath(tmpRoot, 'src/server/secret.ts', ['src/ui/']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgPluginError);
      expect((err as AgPluginError).code).toBe('PATH_OUTSIDE_LOCKED_SCOPE');
    }
  });

  it('TC-S02: blocks symlink escaping workspace root when symlink creation is permitted', () => {
    const outsideFile = path.join(outsideRoot, 'escape.txt');
    fs.writeFileSync(outsideFile, 'outside');
    const linkPath = path.join(tmpRoot, 'src', 'ui', 'escape-link.txt');

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, linkPath);
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode may forbid file symlinks; try directory junction
      try {
        fs.symlinkSync(outsideRoot, path.join(tmpRoot, 'src', 'ui', 'escape-dir'), 'junction');
        expect(() =>
          assertWritablePath(tmpRoot, 'src/ui/escape-dir/escape.txt', ['src/ui/']),
        ).toThrow(AgPluginError);
        return;
      } catch {
        // Environment disallows symlinks & junctions; skip only symlink assertion
        return;
      }
    }

    if (symlinkCreated) {
      try {
        assertWritablePath(tmpRoot, 'src/ui/escape-link.txt', ['src/ui/']);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgPluginError);
        expect((err as AgPluginError).code).toBe('PATH_TRAVERSAL_BLOCKED');
      }
    }
  });

  it('TC-S03: blocks protected paths (.git, .env, .ag-bridge/config.json, node_modules)', () => {
    expect(() => validateLockedPathsConfig(tmpRoot, ['.git/config'])).toThrow(AgPluginError);
    expect(() => validateLockedPathsConfig(tmpRoot, ['.env'])).toThrow(AgPluginError);
    expect(() => validateLockedPathsConfig(tmpRoot, ['.env.local'])).toThrow(AgPluginError);
    expect(() => validateLockedPathsConfig(tmpRoot, ['.ag-bridge/config.json'])).toThrow(
      AgPluginError,
    );
    expect(() => validateLockedPathsConfig(tmpRoot, ['node_modules/pkg'])).toThrow(AgPluginError);

    // Even if passed directly to assertWritablePath
    expect(() => assertWritablePath(tmpRoot, '.env', ['.'])).toThrow(AgPluginError);
    expect(() => assertWritablePath(tmpRoot, '.git/HEAD', ['.'])).toThrow(AgPluginError);
  });

  // One Windows file has several spellings: an 8.3 short name, a trailing dot or space, an alternate
  // data stream (`::$DATA`). Measured on main: each got past the protected-path checks — ENV~1 and
  // .env::$DATA read the secret, src/NODE_M~1/x.js wrote into node_modules, GIT~1 became a
  // lockedPath that allowed GIT~1/hooks/pre-commit, and ".git." was accepted as a lockedPath.
  const shortName = (p: string): string | undefined => {
    const kind = fs.statSync(p).isDirectory() ? 'GetFolder' : 'GetFile';
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).${kind}('${p}').ShortName`],
      { encoding: 'utf8' },
    );
    const name = (r.stdout ?? '').trim();
    return name && name.toLowerCase() !== path.basename(p).toLowerCase() ? name : undefined;
  };

  it.skipIf(process.platform !== 'win32')(
    'TC-S21: an 8.3 short name of .env, node_modules or .git is still protected (Windows)',
    (ctx) => {
      fs.mkdirSync(path.join(tmpRoot, '.git', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'src', 'node_modules'), { recursive: true });
      const envShort = shortName(path.join(tmpRoot, '.env'));
      const gitShort = shortName(path.join(tmpRoot, '.git'));
      const nmShort = shortName(path.join(tmpRoot, 'src', 'node_modules'));
      if (!envShort || !gitShort || !nmShort) {
        ctx.skip(); // 8.3 names are disabled on this volume
        return;
      }

      expect(() => assertReadablePath(tmpRoot, envShort)).toThrow(AgPluginError);
      expect(() => assertWritablePath(tmpRoot, `src/${nmShort}/x.js`, ['src'])).toThrow(AgPluginError);
      expect(() => validateLockedPathsConfig(tmpRoot, [gitShort])).toThrow(AgPluginError);
      expect(() => assertWritablePath(tmpRoot, `${gitShort}/hooks/pre-commit`, [gitShort])).toThrow(
        AgPluginError,
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'TC-S21b: an alternate data stream path is refused (Windows)',
    () => {
      expect(() => assertReadablePath(tmpRoot, '.env::$DATA')).toThrow(AgPluginError);
      expect(() => assertReadablePath(tmpRoot, `${path.join(tmpRoot, '.env')}::$DATA`)).toThrow(AgPluginError);
      expect(() => assertWritablePath(tmpRoot, 'src/ui/App.tsx:hidden', ['src/ui'])).toThrow(AgPluginError);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'TC-S21c: a path segment ending in a dot or a space is refused (Windows strips them)',
    () => {
      expect(() => validateLockedPathsConfig(tmpRoot, ['.git.'])).toThrow(AgPluginError);
      expect(() => assertReadablePath(tmpRoot, '.env ')).toThrow(AgPluginError);
      expect(() => assertWritablePath(tmpRoot, 'src/ui. /App.tsx', ['src/ui'])).toThrow(AgPluginError);
      // ordinary dotted names stay writable
      expect(assertWritablePath(tmpRoot, 'src/ui/App.test.tsx', ['src/ui']).endsWith('App.test.tsx')).toBe(true);
    },
  );

  it('blocks reading .env secrets while allowing .env.example and normal source files', () => {
    expect(() => assertReadablePath(tmpRoot, '.env')).toThrow(AgPluginError);
    expect(() => assertReadablePath(tmpRoot, '../outside.txt')).toThrow(AgPluginError);
    expect(assertReadablePath(tmpRoot, '.env.example')).toContain('.env.example');
    expect(assertReadablePath(tmpRoot, 'src/server/secret.ts')).toContain('secret.ts');
  });
});
