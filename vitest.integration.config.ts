import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export const TEST_PORT = 54330;

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      DATABASE_URL: `postgres://keel:keel-local-only@127.0.0.1:${TEST_PORT}/keel`,
      KEEL_PG_PORT: String(TEST_PORT),
      KEEL_PG_DIR: join(homedir(), '.keel', 'pgtest'),
      KEEL_SEED_CUSTOMERS: '400',
      GEMINI_API_KEY: '',
    },
  },
});
