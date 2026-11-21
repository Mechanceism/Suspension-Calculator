import { defineConfig } from 'vitest/config';

// Tests get their own config and cache folder so they don't share Vite's cache with a running
// dev server (which rewrites it when files change).
export default defineConfig({
  cacheDir: 'node_modules/.vitest',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
