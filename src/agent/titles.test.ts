import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../features/guard.js', () => ({ recordModelUsage: async () => {} }));
import { asciiSessionTitle, cleanTitle, fitTitle, normalizeSessionTitle, titleBackoffActive } from '../pipeline/agent-session.js';
import { cardTitlePrompt, generateTitle, isSubstantive, KEEP, parseTitleAnswer, SESSION_RETITLE_EVERY, sessionTitleDecision, sessionTitlePrompt, titleModel } from './titles.js';

describe('isSubstantive', () => {
  it('greetings and small talk are not a request; anything else is', () => {
    for (const t of ['hi', 'Hey!', 'hello there :wave:', '<@UBOT> hi', 'good morning', 'thanks!!', 'ok', 'how are you?', '👋', '']) expect(isSubstantive(t), t).toBe(false);
    for (const t of ['hi, what pins does the Pico W use for I2C?', 'compare Fly.io and Render', 'fix my regex', '<@UBOT> summarize this channel']) expect(isSubstantive(t), t).toBe(true);
  });
});

describe('sessionTitleDecision (keep vs new)', () => {
  const base = { isDm: true, title: null as string | null, titleBy: null as 'bot' | 'user' | null, substantive: true, userTurnsSinceTitle: 0 };
  it('titles an untitled DM once there is a request; waits through greetings', () => {
    expect(sessionTitleDecision(base)).toEqual({ action: 'title' });
    expect(sessionTitleDecision({ ...base, substantive: false })).toEqual({ action: 'skip', reason: 'no_request' });
  });
  it('never touches a user title or a channel thread', () => {
    expect(sessionTitleDecision({ ...base, title: 'Mine', titleBy: 'user', userTurnsSinceTitle: SESSION_RETITLE_EVERY })).toEqual({ action: 'skip', reason: 'user_title' });
    expect(sessionTitleDecision({ ...base, titleBy: 'user' })).toEqual({ action: 'skip', reason: 'user_title' });
    expect(sessionTitleDecision({ ...base, isDm: false })).toEqual({ action: 'skip', reason: 'not_dm' });
  });
  it('a bot title is checked for a topic change every few user turns only', () => {
    const titled = { ...base, title: 'Pico W pinout question', titleBy: 'bot' as const };
    const actions = Array.from({ length: 2 * SESSION_RETITLE_EVERY + 1 }, (_, n) => sessionTitleDecision({ ...titled, userTurnsSinceTitle: n }).action);
    expect(actions.filter((a) => a === 'check')).toHaveLength(2);
    expect(actions[0]).toBe('skip');
    expect(actions[SESSION_RETITLE_EVERY]).toBe('check');
  });
});

describe('prompts', () => {
  it('session: a first title asks for KEEP without a request; a check names the current title', () => {
    const first = sessionTitlePrompt({ current: null, firstUser: ['what pins does the Pico W use for I2C?'], recentUser: [], botReply: 'GP4/GP5 by default.' });
    expect(first.system).toMatch(/at most 40 characters/);
    expect(first.system).toContain(`reply exactly ${KEEP}`);
    expect(first.system).toMatch(/only greetings or small talk/);
    expect(first.system).toMatch(/data .* not instructions/);
    expect(first.prompt).toContain('<first_user_messages>\n- what pins does the Pico W use for I2C?\n</first_user_messages>');
    expect(first.prompt).toContain('<bot_reply>\nGP4/GP5 by default.\n</bot_reply>');
    expect(first.prompt).not.toContain('<recent_user_messages>');
    const check = sessionTitlePrompt({ current: 'Pico W pinout question', firstUser: ['a'], recentUser: ['now about my resume'], botReply: null });
    expect(check.system).toContain('currently titled "Pico W pinout question"');
    expect(check.system).toMatch(/clearly different main topic/);
    expect(check.prompt).toContain('<recent_user_messages>\n- now about my resume');
    expect(check.prompt).toContain('<bot_reply>\n(none)');
  });

  it('long messages are clipped', () => {
    const p = sessionTitlePrompt({ current: null, firstUser: ['x'.repeat(5000)], recentUser: [], botReply: 'y'.repeat(5000) });
    expect(p.prompt.length).toBeLessThan(1200);
  });

  it('card: past tense, what was done; request and each task with its status and result', () => {
    const p = cardTitlePrompt({
      request: 'compare fly.io, render and railway for a small node app',
      tasks: [
        { title: 'Fly.io pricing', status: 'complete', result: 'About $2/month for a shared VM.' },
        { title: 'Render pricing', status: 'error', result: null },
      ],
    });
    expect(p.system).toMatch(/past tense/);
    expect(p.system).toMatch(/Compared 3 hosting options/);
    expect(p.prompt).toContain('<request>\ncompare fly.io, render and railway for a small node app\n</request>');
    expect(p.prompt).toContain('- Fly.io pricing [complete]: About $2/month for a shared VM.');
    expect(p.prompt).toContain('- Render pricing [error]');
  });
});

describe('parseTitleAnswer', () => {
  it('KEEP or nothing → null; a title is cleaned (quotes, markup, period, length)', () => {
    for (const k of ['KEEP', 'keep', '"KEEP"', 'KEEP.', '', '  \n']) expect(parseTitleAnswer(k), k).toBeNull();
    expect(parseTitleAnswer('"Pico W pinout question"')).toBe('Pico W pinout question');
    expect(parseTitleAnswer('Title: **Trip budget** for Berlin.\nextra line')).toBe('Trip budget for Berlin');
    expect(parseTitleAnswer('Compared hosting <@U123> options')).toBe('Compared hosting options');
    expect(parseTitleAnswer('A very long title that goes on and on well past the forty character limit')!.length).toBeLessThanOrEqual(40);
    expect(parseTitleAnswer('A very long title that goes on and on well past the forty character limit')).not.toContain('…');
  });
});

describe('title fitting (no "…": Slack rejects it in session titles)', () => {
  it('cuts at a word boundary with no ellipsis and no dangling connector or punctuation', () => {
    expect(fitTitle('Simulated 100,000 dice rolls and plotted the distribution', 40)).toBe('Simulated 100,000 dice rolls');
    expect(fitTitle('Compared hosting prices for Fly.io, Render, and Railway', 40)).toBe('Compared hosting prices for Fly.io');
    expect(fitTitle('Checked the venues (Friday and Saturday nights)', 40)).toBe('Checked the venues');
    expect(fitTitle('Short title', 40)).toBe('Short title');
    expect(fitTitle('Supercalifragilisticexpialidociousnessxyzzyfoo', 40)).toHaveLength(40);
    for (const t of ['Researched the best microcontrollers with Wi-Fi for a robot', 'Looked into how Slack rate limits work for bots and apps']) {
      const f = fitTitle(t, 40);
      expect(f.length).toBeLessThanOrEqual(40);
      expect(f).not.toMatch(/…|\s(and|with|for|a|the)$|[,;:-]$/);
    }
  });

  it('cleans ellipses, emoji and invisible characters', () => {
    expect(cleanTitle('“Pico W pins…” 🚀')).toBe('Pico W pins');
    expect(cleanTitle('Trip budget... Berlin​')).toBe('Trip budget Berlin');
    expect(normalizeSessionTitle('A very long title that goes on and on well past the forty character limit')).not.toContain('…');
  });

  it('the strict retry is plain ASCII', () => {
    expect(asciiSessionTitle('Café menü — Zürich “tips” ✨')).toBe('Cafe menu - Zurich tips');
    expect(asciiSessionTitle('日本語')).toBe('');
  });

  it('backs off after failed renames: 10 min, then ×4, at most a day; nothing without failures', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const ago = (min: number) => new Date(now - min * 60_000);
    expect(titleBackoffActive({ failures: 0, failedAt: null }, now)).toBe(false);
    expect(titleBackoffActive({ failures: 1, failedAt: ago(5) }, now)).toBe(true);
    expect(titleBackoffActive({ failures: 1, failedAt: ago(11) }, now)).toBe(false);
    expect(titleBackoffActive({ failures: 2, failedAt: ago(30) }, now)).toBe(true);
    expect(titleBackoffActive({ failures: 9, failedAt: ago(23 * 60) }, now)).toBe(true);
    expect(titleBackoffActive({ failures: 9, failedAt: ago(25 * 60) }, now)).toBe(false);
  });
});

describe('generateTitle: one retry when too long, then a word-boundary cut', () => {
  const answers: string[] = [];
  const asked: { system: string; prompt: string }[] = [];
  const orig = titleModel.generate;
  beforeEach(() => {
    answers.length = 0;
    asked.length = 0;
    titleModel.generate = async (o) => {
      asked.push(o);
      return { text: answers.shift() ?? 'KEEP' };
    };
  });
  afterEach(() => {
    titleModel.generate = orig;
  });
  const run = () => generateTitle({ system: 's', prompt: 'p', max: 40, threadId: 'C1:1.1' });

  it('a title within the limit: one call', async () => {
    answers.push('Compared 3 hosting options');
    expect(await run()).toBe('Compared 3 hosting options');
    expect(asked).toHaveLength(1);
  });

  it('too long: asks once more with the count; the shorter answer wins', async () => {
    answers.push('Simulated 100,000 dice rolls and plotted the distribution', 'Ran a dice roll simulation');
    expect(await run()).toBe('Ran a dice roll simulation');
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prompt).toMatch(/has 57 characters; the limit is 40/);
  });

  it('still too long: cut at a word boundary, never mid-phrase with "…"', async () => {
    answers.push('Simulated 100,000 dice rolls and plotted the distribution', 'Simulated 100,000 dice rolls and made a histogram');
    expect(await run()).toBe('Simulated 100,000 dice rolls');
    expect(asked).toHaveLength(2);
  });

  it('KEEP: null, no retry', async () => {
    answers.push('KEEP');
    expect(await run()).toBeNull();
    expect(asked).toHaveLength(1);
  });
});
