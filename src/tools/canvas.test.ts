import { describe, expect, it } from 'vitest';
import {
  canEditCanvas,
  canvasConversations,
  canvasWindow,
  decideCanvasAccess,
  fromCanvasMarkdown,
  parseCanvasId,
  publicCandidates,
  spliceSection,
  toCanvasMarkdown,
} from './canvas.js';

describe('parseCanvasId', () => {
  it('accepts ids and canvas/file links, also in Slack <url|label> form', () => {
    expect(parseCanvasId('F07ABCDEF12')).toBe('F07ABCDEF12');
    expect(parseCanvasId(' F07ABCDEF12 ')).toBe('F07ABCDEF12');
    expect(parseCanvasId('https://hackclub.slack.com/docs/T0266FRGM/F07ABCDEF12')).toBe('F07ABCDEF12');
    expect(parseCanvasId('https://app.slack.com/docs/T0266FRGM/F07ABCDEF12?focus=1')).toBe('F07ABCDEF12');
    expect(parseCanvasId('<https://hackclub.slack.com/docs/T0266FRGM/F07ABCDEF12|Plan>')).toBe('F07ABCDEF12');
    expect(parseCanvasId('https://hackclub.slack.com/files/U0123ABC/F07ABCDEF12/plan')).toBe('F07ABCDEF12');
  });
  it('rejects everything else', () => {
    for (const s of ['', 'C0123456', 'f07abcdef12', 'https://evil.example/docs/T1/F07ABCDEF12', 'https://slack.com.evil.io/docs/T1/F07ABCDEF12', 'https://x.slack.com/archives/C1/p1790000000000100', 'javascript:F07ABCDEF12'])
      expect(parseCanvasId(s)).toBeUndefined();
  });
});

describe('access rule', () => {
  const file = {
    channels: ['CPUB'],
    groups: ['GPRIV'],
    ims: ['DSOMEONE'],
    shares: { public: { CSHARED: [] }, private: { CPRIVNEW: [] } },
    linked_channel_id: 'CTAB',
  };
  it('collects every conversation and skips DMs for public checks', () => {
    expect([...canvasConversations(file)].sort()).toEqual(['CPRIVNEW', 'CPUB', 'CSHARED', 'CTAB', 'DSOMEONE', 'GPRIV']);
    expect(publicCandidates(file)).not.toContain('DSOMEONE');
  });
  const base = { channelId: 'CHERE', speakerId: 'USPEAK', publicIds: new Set<string>() };
  it('bot-created: same conversation, creator, or created in a public channel', () => {
    expect(decideCanvasAccess({ ...base, row: { channelId: 'CHERE', creatorId: 'UOTHER' } })).toEqual({ ok: true, via: 'bot_created' });
    expect(decideCanvasAccess({ ...base, row: { channelId: 'DELSE', creatorId: 'USPEAK' } })).toEqual({ ok: true, via: 'bot_created' });
    expect(decideCanvasAccess({ ...base, row: { channelId: 'CPUB', creatorId: 'UOTHER' }, publicIds: new Set(['CPUB']) }).ok).toBe(true);
    // Someone else's DM deliverable stays private.
    expect(decideCanvasAccess({ ...base, row: { channelId: 'DELSE', creatorId: 'UOTHER' } }).ok).toBe(false);
  });
  it('shared in this conversation', () => {
    expect(decideCanvasAccess({ ...base, channelId: 'GPRIV', file })).toEqual({ ok: true, via: 'this_conversation' });
    expect(decideCanvasAccess({ ...base, channelId: 'DSOMEONE', file })).toEqual({ ok: true, via: 'this_conversation' });
  });
  it('shared in a verified public channel only', () => {
    expect(decideCanvasAccess({ ...base, file }).ok).toBe(false); // nothing verified
    expect(decideCanvasAccess({ ...base, file, publicIds: new Set(['CSHARED']) })).toEqual({ ok: true, via: 'public_channel' });
    expect(decideCanvasAccess({ ...base, file, publicIds: new Set(['CNOTSHARED']) }).ok).toBe(false);
    expect(decideCanvasAccess({ ...base, file: null }).ok).toBe(false);
  });
  it('edit only bot-created, from its conversation or for its creator', () => {
    expect(canEditCanvas(null, 'CHERE', 'USPEAK')).toBe(false);
    expect(canEditCanvas({ channelId: 'CHERE', creatorId: 'UOTHER' }, 'CHERE', 'USPEAK')).toBe(true);
    expect(canEditCanvas({ channelId: 'CELSE', creatorId: 'USPEAK' }, 'CHERE', 'USPEAK')).toBe(true);
    expect(canEditCanvas({ channelId: 'CELSE', creatorId: 'UOTHER' }, 'CHERE', 'USPEAK')).toBe(false);
  });
});

describe('markdown conversion', () => {
  it('converts mentions and links to canvas syntax outside code', () => {
    const md = 'hi <@U123|ingo> see <#C456|ship> and <https://x.dev|the docs> or <https://y.dev>\n```ts\nconst a = "<@U999>";\n```\n';
    expect(toCanvasMarkdown(md)).toBe('hi ![](@U123) see ![](#C456) and [the docs](https://x.dev) or https://y.dev\n```ts\nconst a = "<@U999>";\n```\n');
  });
  it('neutralises group pings everywhere, incl. canvas mention syntax', () => {
    const out = toCanvasMarkdown('<!channel> <!here|here> @everyone <!subteam^S123|@staff> ![](@S999) ![](!here)\n```\n<!channel>\n```');
    expect(out).not.toMatch(/<!(channel|here|everyone|subteam)/);
    expect(out).not.toMatch(/(^|[^​])@(channel|here|everyone)\b/);
    expect(out).not.toContain('![](@S');
    expect(out).not.toContain('![](!');
  });
  it('converts canvas mentions back', () => {
    expect(fromCanvasMarkdown('# T\r\n![](@U123) in ![](#C456)\n\n\n\n\nend')).toBe('# T\n<@U123> in <#C456>\n\n\nend');
  });
  it('windows long text at line breaks', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const a = canvasWindow(text, 0, 100);
    expect(a.body.length).toBeLessThanOrEqual(100);
    expect(a.body.endsWith('\n')).toBe(false);
    expect(a.next).toBe(a.body.length);
    const b = canvasWindow(text, a.next!, 10_000);
    expect(a.body + b.body).toBe(text);
    expect(b.next).toBeUndefined();
  });
});

describe('spliceSection', () => {
  const doc = '# Plan\nintro\n## Budget\nold budget\n### Detail\nold detail\n## Venue\nvenue text\n```\n## not a heading\n```\n';
  it('replaces the body under a heading up to the next heading of the same level', () => {
    const r = spliceSection(doc, 'budget', 'new budget');
    expect('markdown' in r && r.markdown).toBe('# Plan\nintro\n## Budget\n\nnew budget\n\n## Venue\nvenue text\n```\n## not a heading\n```\n');
  });
  it('replaces the heading too when the content starts with one', () => {
    const r = spliceSection(doc, '## Venue', '## Location\nsomewhere');
    expect('markdown' in r && r.markdown).toBe('# Plan\nintro\n## Budget\nold budget\n### Detail\nold detail\n## Location\nsomewhere');
  });
  it('ignores headings in code and reports ambiguity / misses', () => {
    expect('error' in spliceSection(doc, 'not a heading', 'x')).toBe(true);
    const amb = spliceSection('## Day 1\na\n## Day 2\nb', 'day', 'x');
    expect('error' in amb && amb.error).toMatch(/2 headings match/);
    // exact match wins over substring matches
    const ex = spliceSection('## Day\na\n## Day 2\nb', 'Day', 'x');
    expect('markdown' in ex && ex.markdown).toBe('## Day\n\nx\n\n## Day 2\nb');
  });
});
