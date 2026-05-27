import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Shard safety: no mutable module-level singletons; each vi.mock is
    // reset in beforeEach. Safe to run with --shard=<index>/<total>.
    sequence: { shuffle: false },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@craft/types': path.resolve(__dirname, '../../packages/types/src'),
      '@craft/stellar': path.resolve(__dirname, '../../packages/stellar/src'),
    },
  },
});
