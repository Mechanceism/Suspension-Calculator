import { defineConfig } from 'vitest/config';

// Tests get their own config and cache folder so they don't share Vite's cache with a running
// dev server (which rewrites it when files change).
export default defineConfig({
  cacheDir: 'node_modules/.vitest',
  test: {
    include: ['tests/**/*.test.ts'],
    // The default worker pools (threads / forks) fail on this machine before any test runs
    // ("Cannot read properties of undefined (reading 'config')"), even after a clean reinstall;
    // vmThreads works. Its runs are slower, so the solver-heavy tests get a longer time limit.
    pool: 'vmThreads',
    testTimeout: 120_000,
  },
});
