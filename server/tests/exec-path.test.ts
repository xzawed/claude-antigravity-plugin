import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExecutable, windowsShell } from '../src/exec-path.js';

// A relative PATH entry (".", "bin", "node_modules\.bin", drive-relative "C:tools", or an empty
// POSIX entry) resolves against the child's cwd — the user's workspace. A program found there is
// one the opened repository supplied, so the plugin must never launch it.

describe('exec-path: programs come from absolute PATH entries only (TC-S12, TC-S15, TC-S16)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-execpath-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TC-S12a: skips every relative Windows PATH entry even when it holds the program', () => {
    const found = resolveExecutable('git', {
      platform: 'win32',
      env: {
        // drive-relative "C:tools" and root-relative "\Tools" depend on the current drive/directory
        Path: '.;bin;C:tools;\\Tools;node_modules\\.bin;"C:\\Program Files\\Git\\cmd";C:\\Windows\\System32',
      },
      isCandidate: (p) => /git\.exe$/i.test(p),
    });
    expect(found).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('TC-S12b: skips relative and empty POSIX PATH entries (an empty entry means the cwd)', () => {
    const found = resolveExecutable('git', {
      platform: 'linux',
      env: { PATH: ':.:bin:./node_modules/.bin:/opt/git/bin:/usr/bin' },
      isCandidate: (p) => p === 'git' || p.endsWith('/git'),
    });
    expect(found).toBe('/opt/git/bin/git');
  });

  it('TC-S12c: on Windows only .com/.exe can be spawned without a shell, so an earlier git.cmd is passed over', () => {
    const present = new Set(['C:\\Shims\\git.cmd', 'C:\\Shims\\git.bat', 'C:\\Git\\cmd\\git.exe']);
    const found = resolveExecutable('git', {
      platform: 'win32',
      env: { PATH: 'C:\\Shims;C:\\Git\\cmd', PATHEXT: '.CMD;.BAT;.EXE' },
      isCandidate: (p) => present.has(p),
    });
    expect(found).toBe('C:\\Git\\cmd\\git.exe');
  });

  it('TC-S12d: returns undefined when only relative entries hold the program', () => {
    expect(
      resolveExecutable('taskkill', {
        platform: 'win32',
        env: { PATH: '.;tools;C:tools' },
        isCandidate: () => true,
      }),
    ).toBeUndefined();
    expect(
      resolveExecutable('xclip', { platform: 'linux', env: { PATH: '.:bin:' }, isCandidate: () => true }),
    ).toBeUndefined();
  });

  it('TC-S12f: an unset POSIX PATH falls back to /usr/bin:/bin as execvp does; an empty one (= the cwd) finds nothing', () => {
    const present = (p: string): boolean => p === '/usr/bin/git';
    expect(resolveExecutable('git', { platform: 'linux', env: {}, isCandidate: present })).toBe('/usr/bin/git');
    expect(resolveExecutable('git', { platform: 'linux', env: { PATH: '' }, isCandidate: present })).toBeUndefined();
    // Windows has no such default: an empty search found only the cwd, which is never searched here.
    expect(
      resolveExecutable('git', { platform: 'win32', env: {}, isCandidate: () => true }),
    ).toBeUndefined();
  });

  it('TC-S12e: the default probe skips directories and, on POSIX, files without the execute bit', () => {
    const isWin = process.platform === 'win32';
    const fileName = isWin ? 'ag-probe-tool.exe' : 'ag-probe-tool';
    const dirA = path.join(tmpRoot, 'a');
    const dirB = path.join(tmpRoot, 'b');
    const dirC = path.join(tmpRoot, 'c');
    fs.mkdirSync(path.join(dirA, fileName), { recursive: true }); // a directory named like the program
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirB, fileName), '', { mode: 0o644 });
    fs.mkdirSync(dirC);
    fs.writeFileSync(path.join(dirC, fileName), '', { mode: 0o755 });

    const found = resolveExecutable('ag-probe-tool', {
      env: { PATH: [dirA, dirB, dirC].join(path.delimiter) },
    });
    // Windows has no execute bit: the first regular file wins. POSIX execvp skips a file it cannot
    // execute and keeps searching, so must the resolver.
    expect(found).toBe(path.join(isWin ? dirB : dirC, fileName));
  });

  it('TC-S15: the Windows shell is an absolute ComSpec, else %SystemRoot%\\System32\\cmd.exe — never a bare name', () => {
    expect(windowsShell({ ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' })).toBe('C:\\WINDOWS\\system32\\cmd.exe');
    expect(windowsShell({ COMSPEC: 'cmd.exe', SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe');
    expect(windowsShell({ ComSpec: '.\\cmd.exe', SystemRoot: 'Win' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(windowsShell({})).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('TC-S16: no source file launches a program by a literal name or through a shell', () => {
    const srcDir = path.resolve(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcDir);

    const rules: Array<{ re: RegExp; why: string }> = [
      { re: /(?<![\w$.])(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\(\s*(['"`])/g, why: 'literal program name' },
      { re: /\bcommand:\s*(['"`])/g, why: 'literal program name in a spawn spec' },
      { re: /\bshell:\s*true\b/g, why: 'shell: true (the shell searches the cwd)' },
      // A value, not a list entry: `isWin ? 'cmd.exe' : bin`, `command: 'cmd.exe'`, `= 'cmd.exe'`.
      { re: /[=?:]\s*(['"`])cmd\.exe\1/gi, why: 'bare cmd.exe value (use windowsShell())' },
      // git runs only through git-guard.ts's runGit, which turns repository commands off (TC-S20).
      { re: /(?:require|resolve)Executable\(\s*(['"`])git(?:\.exe)?\1/g, why: 'git launched outside git-guard.ts' },
    ];

    const violations: string[] = [];
    for (const file of files) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      for (const { re, why } of rules) {
        if (rel === 'git-guard.ts' && why.startsWith('git launched')) continue;
        for (const m of code.matchAll(re)) {
          const line = code.slice(0, m.index).split('\n').length;
          violations.push(`${rel}:${line} ${why}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
