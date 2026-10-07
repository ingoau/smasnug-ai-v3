/**
 * LIVE=1 pnpm vitest run src/agent/titles.live.test.ts — the background title generator against the real model
 * (Hack Club first, a handful of tiny requests): a first title, KEEP on a greeting and an unchanged topic, a new
 * title on a clear topic change, and a past-tense card title.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE && existsSync('.env')) process.loadEnvFile('.env');

describe.skipIf(!LIVE)('title generator (live)', () => {
  const ask = async (p: { system: string; prompt: string }) => {
    const { titleModel, parseTitleAnswer } = await import('./titles.js');
    const res = await titleModel.generate(p);
    return { raw: res.text, title: parseTitleAnswer(res.text) };
  };

  it('titles, keeps and retitles a DM conversation', async () => {
    const { sessionTitlePrompt } = await import('./titles.js');
    const first = await ask(sessionTitlePrompt({ current: null, firstUser: ['which pins does the raspberry pi pico w use for i2c by default?'], recentUser: [], botReply: 'I2C0 defaults to GP4 (SDA) and GP5 (SCL).' }));
    console.log('first:', first.raw);
    expect(first.title).toBeTruthy();
    expect(first.title!.length).toBeLessThanOrEqual(40);
    expect(first.title!.toLowerCase()).toMatch(/pico|i2c|pin/);

    const greeting = await ask(sessionTitlePrompt({ current: null, firstUser: ['hey!'], recentUser: [], botReply: 'Hi! What can I do for you?' }));
    console.log('greeting:', greeting.raw);
    expect(greeting.title).toBeNull();

    const same = await ask(sessionTitlePrompt({ current: 'Pico W I2C pins', firstUser: ['which pins does the pico w use for i2c?'], recentUser: ['and which ones for SPI?', 'can I use both at once?'], botReply: 'Yes, I2C0 and SPI0 can run together.' }));
    console.log('same topic:', same.raw);
    expect(same.title).toBeNull();

    const changed = await ask(
      sessionTitlePrompt({ current: 'Pico W I2C pins', firstUser: ['which pins does the pico w use for i2c?'], recentUser: ['ok different thing: can you review my cover letter for a barista job?', 'here it is: Dear hiring manager, ...'], botReply: 'Sure. Your opening is strong; tighten the second paragraph.' }),
    );
    console.log('changed topic:', changed.raw);
    expect(changed.title).toBeTruthy();
    expect(changed.title!.toLowerCase()).toMatch(/cover letter|barista|job/);
  }, 60_000);

  it('a past-tense card title', async () => {
    const { cardTitlePrompt } = await import('./titles.js');
    const r = await ask(
      cardTitlePrompt({
        request: 'compare fly.io, render and railway for hosting a small node app',
        tasks: [
          { title: 'Fly.io pricing and limits', status: 'complete', result: 'Shared VM from about $2/month; free allowance removed.' },
          { title: 'Render pricing and limits', status: 'complete', result: 'Free tier sleeps after 15 min; starter $7/month.' },
          { title: 'Railway pricing and limits', status: 'complete', result: 'Usage-based, $5/month hobby plan.' },
        ],
      }),
    );
    console.log('card:', r.raw);
    expect(r.title).toBeTruthy();
    expect(r.title!.length).toBeLessThanOrEqual(40);
  }, 30_000);
});
