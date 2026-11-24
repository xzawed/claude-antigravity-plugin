/**
 * Static check that a committed bundle reaches only Node built-ins at runtime (ADR-004, G5).
 *
 * Starting the bundle with no node_modules (smoke-bundle.mjs) is not proof on its own: a
 * createRequire-based `require()` — which the bundle banner installs and esbuild's
 * `__require` shim calls for CommonJS dependencies — also searches NODE_PATH and Node's
 * global folders, so a runner's environment could satisfy a dependency the bundle failed
 * to inline. ESM `import` ignores NODE_PATH. (Both measured 2026-11-24.)
 *
 * Only shapes that esbuild itself emits are inspected, so imports quoted in comments or in
 * generated-code strings (ajv, google-auth-library JSDoc) are not mistaken for real ones:
 *   - column-0 static `import ... from "x"` / `import "x"` (externals hoisted to the top)
 *   - `__require("x")` and `__require(<expr>)` (esbuild's CommonJS require shim)
 *   - `import("x")` with a string literal
 * A computed `import(<expr>)` or `require(<expr>)` is rejected at build time instead: build.mjs
 * promotes esbuild's `unsupported-dynamic-import` / `unsupported-require-call` to errors.
 */
import { isBuiltin } from 'node:module';

/** Optional native accelerators that ws and debug load inside try/catch; absence is handled. */
export const OPTIONAL_REQUIRES = new Set(['bufferutil', 'utf-8-validate', 'supports-color']);

const STATIC_IMPORT = /^import\s*(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/;
const SHIM_REQUIRE = /__require\(\s*(?:(['"])([^'"]*)\1)?/g;
const DYNAMIC_IMPORT_LITERAL = /\bimport\(\s*(['"])([^'"]+)\1/g;

/** @param {string} source bundle text @returns {string[]} problems (empty = self-contained) */
export function scanBundle(source) {
  const problems = new Set();

  for (const line of source.split('\n')) {
    const m = STATIC_IMPORT.exec(line);
    if (m && !isBuiltin(m[1])) problems.add(`static import of non-built-in "${m[1]}"`);
  }

  for (const m of source.matchAll(SHIM_REQUIRE)) {
    if (m[2] === undefined) problems.add('__require with a computed argument');
    else if (!isBuiltin(m[2]) && !OPTIONAL_REQUIRES.has(m[2])) problems.add(`__require of non-built-in "${m[2]}"`);
  }

  for (const m of source.matchAll(DYNAMIC_IMPORT_LITERAL)) {
    if (!isBuiltin(m[2])) problems.add(`dynamic import of non-built-in "${m[2]}"`);
  }

  return [...problems];
}
