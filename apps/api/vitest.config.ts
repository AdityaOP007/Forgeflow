import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        'postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow_test',
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        'postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow_test',
      NODE_ENV: 'test',
      PORT: '4000',
      WEB_ORIGIN: 'http://localhost:5173',
    },
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15000,
  },
});
