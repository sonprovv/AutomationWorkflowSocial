import { defineConfig } from 'vitest/config';

// Default test run: unit + contract tests against local fixtures/servers only.
// Never calls real providers (no network cost, no credentials needed).
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts'],
    exclude: ['**/*.live.test.ts', '**/node_modules/**'],
    testTimeout: 15_000,
  },
});
