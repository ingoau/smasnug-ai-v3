import { describe, expect, it } from 'vitest';
import { activityForTool, DEFAULT_ACTIVITY } from './activity.js';

describe('activityForTool', () => {
  it('labels lookups and work tools', () => {
    expect(activityForTool('web_search')).toBe('Searching the web…');
    expect(activityForTool('slack_search')).toBe('Searching Slack…');
    expect(activityForTool('slack_semantic_search')).toBe('Searching Slack…');
    expect(activityForTool('fetch_url')).toBe('Reading the page…');
    expect(activityForTool('read_thread')).toBe('Reading the thread…');
    expect(activityForTool('ask_thread')).toBe('Reading the thread…');
    expect(activityForTool('read_public_thread')).toBe('Reading a Slack thread…');
    expect(activityForTool('read_public_channel')).toBe('Reading a Slack channel…');
    expect(activityForTool('read_channel')).toBe('Reading the channel…');
    expect(activityForTool('read_file')).toBe('Opening the file…');
    expect(activityForTool('spawn_subagent')).toBe('Starting a subagent…');
    expect(activityForTool('remember')).toBe('Saving a note…');
  });

  it('responding tools never show or change the indicator', () => {
    for (const t of ['reply', 'react', 'unreact', 'search_emojis']) expect(activityForTool(t)).toBeNull();
  });

  it('naming a DM session or leaving is bookkeeping, not work', () => {
    expect(activityForTool('set_session_title')).toBeNull();
    expect(activityForTool('leave_thread')).toBeNull();
  });

  it('unknown tools get a generic label', () => {
    expect(activityForTool('some_new_tool')).toBe(DEFAULT_ACTIVITY);
  });
});

describe('quietAfterReply', () => {
  it('bookkeeping after the reply leaves the indicator alone; real lookups still show it', async () => {
    const { quietAfterReply } = await import('./activity.js');
    for (const t of ['remember', 'forget', 'propose_workspace_fact', 'set_reminder', 'create_watch']) expect(quietAfterReply(t)).toBe(true);
    for (const t of ['web_search', 'fetch_url', 'spawn_subagent', 'send_message']) expect(quietAfterReply(t)).toBe(false);
  });
});
