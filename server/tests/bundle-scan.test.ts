import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanBundle } from '../scripts/bundle-scan.mjs';

const banner =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

describe('bundle-scan: the committed bundle may reach only Node built-ins (ADR-004, G5)', () => {
  it('accepts built-in static imports, the createRequire banner and optional try/catch requires', () => {
    const src = [
      banner,
      'import fs from "node:fs";',
      'import { readFile } from "fs/promises";',
      'import * as path from "path";',
      'const b = await import("node:buffer");',
      'try { const bu = __require("bufferutil"); } catch {}',
      'const c = __require("crypto");',
    ].join('\n');
    expect(scanBundle(src)).toEqual([]);
  });

  it('ignores imports and requires that only appear in comments or generated-code strings', () => {
    const src = [
      banner,
      "   * import { Ajv } from 'ajv';",
      "   * const {JWT} = require('google-auth-library');",
      "    uri.code = 'require(\"ajv/dist/runtime/uri\").default';",
      '// emits an indexed access rather than an inline `import()` of an ESM path',
    ].join('\n');
    expect(scanBundle(src)).toEqual([]);
  });

  it('rejects a top-level static import of a package left external', () => {
    expect(scanBundle(`${banner}\nimport { GoogleGenAI } from "@google/genai";`)).toEqual([
      'static import of non-built-in "@google/genai"',
    ]);
    expect(scanBundle(`${banner}\nimport "zod";`)).toEqual(['static import of non-built-in "zod"']);
  });

  it('rejects __require of a non-built-in that is not a known optional module', () => {
    expect(scanBundle(`${banner}\nconst z = __require("zod");`)).toEqual(['__require of non-built-in "zod"']);
  });

  it('rejects __require and import() with a computed argument', () => {
    expect(scanBundle(`${banner}\nconst m = __require(name);`)).toEqual(['__require with a computed argument']);
    expect(scanBundle(`${banner}\nconst m = await import("left-pad");`)).toEqual([
      'dynamic import of non-built-in "left-pad"',
    ]);
  });

  it('passes on the committed dist/index.js and dist/cli-init.js', () => {
    for (const file of ['index.js', 'cli-init.js']) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dist', file), 'utf8');
      expect(scanBundle(source), file).toEqual([]);
    }
  });
});
