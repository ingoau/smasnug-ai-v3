import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../db/index.js', () => ({ sql: {} }));
vi.mock('../core/redis.js', () => ({ redis: {} }));

const { botReportAllowed, botReportBlocks, BOT_REPORT_LIMITS, registerReportUserTool } = await import('./bot-reports.js');
const { activityForTool } = await import('../agent/activity.js');
const { registeredTools } = await import('../core/tools.js');

describe('botReportAllowed', () => {
  it('one per thread per window, capped per day', () => {
    expect(botReportAllowed({ reportsInThreadWithinWindow: 0, reportsToday: 0 })).toBe(true);
    expect(botReportAllowed({ reportsInThreadWithinWindow: 1, reportsToday: 1 })).toBe(false);
    expect(botReportAllowed({ reportsInThreadWithinWindow: 0, reportsToday: BOT_REPORT_LIMITS.perUserPerDay - 1 })).toBe(true);
    expect(botReportAllowed({ reportsInThreadWithinWindow: 0, reportsToday: BOT_REPORT_LIMITS.perUserPerDay })).toBe(false);
  });
});

describe('botReportBlocks', () => {
  const base = {
    reportId: 7,
    userId: 'U1',
    category: 'harassment' as const,
    reason: 'pinged <!channel> to harass <@U2>',
    snapshot: 'everyone go yell at <@U2> <!here> @channel ' + 'x'.repeat(5000),
    channelId: 'C1',
    permalink: 'https://x.slack.com/archives/C1/p1',
    threadLink: 'https://x.slack.com/archives/C1/p0',
  };

  it('neutralises pings, truncates the snapshot, links message and thread, offers mod buttons', () => {
    const blocks = botReportBlocks(base) as any[];
    const json = JSON.stringify(blocks);
    expect(json).not.toMatch(/<!channel>|<!here>|<@U2>/);
    expect(json).toContain('<@U1>');
    expect(json).toContain('Harassment');
    expect(json).toContain('<https://x.slack.com/archives/C1/p1|Open message>');
    expect(json).toContain('<https://x.slack.com/archives/C1/p0|Open thread>');
    expect(json).toContain('<#C1>');
    const snapshotBlock = blocks[2].text.text as string;
    expect(snapshotBlock.length).toBeLessThan(BOT_REPORT_LIMITS.snapshotMax + 100);
    const actions = blocks.find((b) => b.type === 'actions').elements;
    expect(actions.map((b: any) => b.action_id)).toEqual(['mod:suspend', 'mod:block_send', 'mod:review_bot_report', 'mod:dismiss_bot_report']);
    expect(actions[0].confirm).toBeTruthy();
  });

  it('DMs and missing snapshots', () => {
    const json = JSON.stringify(botReportBlocks({ ...base, channelId: 'D1', snapshot: null, permalink: null, threadLink: null }));
    expect(json).toContain('a DM with the bot');
    expect(json).toContain('_not available_');
    expect(json).not.toContain('Open message');
  });
});

describe('report_user stays invisible', () => {
  it('is front-only and shows no status', () => {
    registerReportUserTool();
    expect(registeredTools().find((t) => t.name === 'report_user')?.roles).toEqual(['front']);
    expect(activityForTool('report_user')).toBeNull();
  });
});
