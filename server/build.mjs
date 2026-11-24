// Bundles the plugin's two Node entry points into self-contained files that are COMMITTED,
// because a marketplace install (`/plugin install`) copies the repository as-is and never runs
// `npm install` or `npm run build`:
//   - src/index.ts    -> dist/index.js     (the MCP server; launched by .mcp.json)
//   - src/cli-init.ts -> dist/cli-init.js  (the SessionStart hook; launched by hooks/hooks.json)
// CI rebuilds and fails if the committed files differ from a fresh build, and smoke-tests them
// before `npm ci` so nothing from node_modules can mask a missing dependency.
// See docs/06-adr/ADR-004-prebuilt-server-bundle.md.
import { build } from 'esbuild';

await build({
  entryPoints: [
    { in: 'src/index.ts', out: 'index' },
    { in: 'src/cli-init.ts', out: 'cli-init' },
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Same floor as `engines.node` in package.json: end users run these files on whatever Node
  // they already have, and nothing installs or checks dependencies for them.
  target: 'node20',
  outdir: 'dist',
  // Each entry point keeps its own `import.meta.url` guard, so they must stay separate bundles
  // (index.ts never imports cli-init.ts). Bundled CommonJS dependencies may call `require`;
  // provide it so the ESM bundle stays self-contained.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'eof',
  logLevel: 'warning',
});

console.error('bundled -> dist/index.js, dist/cli-init.js');
