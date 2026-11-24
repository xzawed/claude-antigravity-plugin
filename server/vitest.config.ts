import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node 20 is below vitest 5's supported range; see the shim for why CI still runs it there.
    globalSetup: ['./tests/setup/node20-reporter-shim.ts'],
    // Git-for-Windows and stdio MCP tests can exceed Vitest's 5 s default under parallel worker load.
    testTimeout: 20_000,
  },
});
