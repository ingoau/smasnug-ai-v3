/**
 * Import FIRST from emoji-files.test.ts: fake userbot session before config.ts reads process.env.
 * Unset in that file's afterAll so later tests in the same worker don't inherit it.
 */
import './test-env.js';

process.env.SLACK_TEAM_XOXC = 'xoxc-test';
process.env.SLACK_XOXD = 'xoxd-test/value';
