import { describe, expect, it } from 'vitest';
import { activityForTool, DEFAULT_ACTIVITY } from './activity.js';

describe('activityForTool', () => {
  it('labels lookups and work tools', () => {
    expect(activityForTool('web_search')).toBe('Searching the web…');
    expect(activityForTool('slack_search')).toBe('Searching Slack…');
    expect(activityForTool('slack_semantic_search')).toBe('Searching Slack…');
    expect(activityForTool('fetch_url')).toBe('Reading the page…');
    expect(activityForTool('read_thread')).toBe('Reading the thread…');
    expect(activityForTool('read_channel')).toBe('Reading the channel…');
    expect(activityForTool('read_image')).toBe('Looking at the image…');
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
