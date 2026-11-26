import { defineConfig } from 'vitest/config';

// `npm test` runs two projects, neither of which calls real providers (no network cost, no credentials):
//  - unit:        pure unit + contract tests (local fake HTTP servers)
//  - integration: real PostgreSQL (embedded, ephemeral) + API + services + inline job dispatcher
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
          exclude: ['**/*.live.test.ts', '**/node_modules/**'],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['**/*.live.test.ts', '**/node_modules/**'],
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
