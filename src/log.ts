import pino from 'pino';
import { env } from './config.js';

export const log = pino({
  level: env.LOG_LEVEL,
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
  // Preview secrets (src/sandbox/preview/): the Cloudflare token and claim URL must never reach a log line.
  redact: {
    paths: ['apiToken', 'api_token', 'apiTokenEnc', 'claimUrl', 'claim_url', 'claimUrlEnc', '*.apiToken', '*.api_token', '*.apiTokenEnc', '*.claimUrl', '*.claim_url', '*.claimUrlEnc'],
    censor: '[redacted]',
  },
});
