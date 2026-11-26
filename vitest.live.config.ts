import { defineConfig } from 'vitest/config';

// Opt-in live smoke tests: call REAL provider APIs with bounded budgets.
// Run with: npm run test:live   (requires network; YouTube requires YOUTUBE_API_KEY)
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.live.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
