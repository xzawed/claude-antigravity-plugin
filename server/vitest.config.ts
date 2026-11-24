import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node 20 is below vitest 5's supported range; see the shim for why CI still runs it there.
    globalSetup: ['./tests/setup/node20-reporter-shim.ts'],
  },
});
