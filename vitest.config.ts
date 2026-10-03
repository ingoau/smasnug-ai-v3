import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Tests never touch the dev database/Redis: DATABASE_URL/REDIS_URL are swapped for TEST_DATABASE_URL/
    // TEST_REDIS_URL (default: smasnug_test + Redis db 9) and SLACK_FAKE=1 is forced. See src/testing/test-db.ts.
    globalSetup: ['src/testing/vitest-global.ts'],
    setupFiles: ['src/testing/vitest-env.ts'],
  },
});
