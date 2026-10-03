import pino from 'pino';
import { env } from './config.js';

export const log = pino({
  level: env.LOG_LEVEL,
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});
