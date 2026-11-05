import { describe, expect, it } from 'vitest';
import { slackDownloadUrl } from './slack-download.js';

describe('slackDownloadUrl', () => {
  it('rewrites a files-pri URL to its download form', () => {
    expect(slackDownloadUrl('https://files.slack.com/files-pri/T1-F2/quiz_4.pdf')).toBe('https://files.slack.com/files-pri/T1-F2/download/quiz_4.pdf');
  });
  it('leaves download URLs and other URLs alone', () => {
    expect(slackDownloadUrl('https://files.slack.com/files-pri/T1-F2/download/a.pdf')).toBe('https://files.slack.com/files-pri/T1-F2/download/a.pdf');
    expect(slackDownloadUrl('https://example.com/files-pri/T1-F2/a.pdf')).toBe('https://example.com/files-pri/T1-F2/a.pdf');
  });
});
