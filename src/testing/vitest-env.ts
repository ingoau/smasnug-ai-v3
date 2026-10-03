/**
 * vitest `setupFiles`: runs in every test worker before each test file. Pins DATABASE_URL / REDIS_URL to the test
 * infra and forces SLACK_FAKE=1. Test files that later call `process.loadEnvFile('.env')` cannot undo this
 * (loadEnvFile never overrides variables that are already set).
 */
import { applyTestEnv } from './test-db.js';

applyTestEnv();
