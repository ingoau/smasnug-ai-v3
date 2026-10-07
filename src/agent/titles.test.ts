import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { cardTitlePrompt, isSubstantive, KEEP, parseTitleAnswer, SESSION_RETITLE_EVERY, sessionTitleDecision, sessionTitlePrompt } from './titles.js';

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
  });
});
