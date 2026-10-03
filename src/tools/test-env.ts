/**
 * Import FIRST in tests that touch config/db/redis/slack: loads .env (if present) and forces SLACK_FAKE=1 before
 * any module reads process.env. ESM evaluates imports in order, so this runs before `config.ts`/`slack.ts`.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.SLACK_FAKE = '1';
process.env.LOG_LEVEL ??= 'warn';
process.env.OPENROUTER_KEY ??= 'test';
