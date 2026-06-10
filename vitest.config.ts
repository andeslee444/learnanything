import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['dotenv/config'],
    fileParallelism: false, // tests share one Postgres database
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
