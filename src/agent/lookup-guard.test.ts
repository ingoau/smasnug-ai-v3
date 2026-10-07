import { describe, expect, it } from 'vitest';
import { countLookupSteps, isLookupStep, LOOKUP_TOOLS, lookupGuard, nonLookupTools } from './lookup-guard.js';
import { TERMINAL_SAFE_TOOLS } from './turn-end.js';

describe('isLookupStep', () => {
  it('research calls alone, or next to an ack reply / reaction, make a lookup step', () => {
    expect(isLookupStep(['web_search'])).toBe(true);
    expect(isLookupStep(['web_search', 'web_search', 'fetch_url'])).toBe(true);
    expect(isLookupStep(['reply', 'web_search'])).toBe(true);
    expect(isLookupStep(['react', 'slack_search', 'slack_search'])).toBe(true);
    for (const t of ['ask_thread', 'read_thread', 'read_channel', 'read_public_channel', 'read_public_thread', 'read_canvas', 'read_file', 'ask_file'])
      expect(isLookupStep([t])).toBe(true);
  });

  it('a step that delegates, sends or creates something, or has no research call, is not', () => {
    expect(isLookupStep([])).toBe(false);
    expect(isLookupStep(['reply'])).toBe(false);
    expect(isLookupStep(['web_search', 'spawn_subagent'])).toBe(false);
    expect(isLookupStep(['read_canvas', 'edit_canvas'])).toBe(false);
    expect(isLookupStep(['fetch_url', 'create_file'])).toBe(false);
    expect(isLookupStep(['list_reminders'])).toBe(false);
  });

  it('no terminal-safe tool counts as research', () => {
    for (const t of TERMINAL_SAFE_TOOLS) expect(LOOKUP_TOOLS.has(t)).toBe(false);
  });
});

describe('countLookupSteps / lookupGuard', () => {
  const opts = { nudgeAfter: 3, restrictAfter: 2 };

  it('counts only lookup steps', () => {
    expect(countLookupSteps([['web_search'], ['reply', 'spawn_subagent'], ['fetch_url', 'fetch_url'], ['reply']])).toBe(2);
  });

  it('one or two lookups are untouched; then a nudge; then research is switched off', () => {
    expect(lookupGuard(0, opts)).toBe('none');
    expect(lookupGuard(1, opts)).toBe('none');
    expect(lookupGuard(2, opts)).toBe('none');
    expect(lookupGuard(3, opts)).toBe('nudge');
    expect(lookupGuard(4, opts)).toBe('nudge');
    expect(lookupGuard(5, opts)).toBe('restrict');
    expect(lookupGuard(9, opts)).toBe('restrict');
  });

  it('nudgeAfter 0 turns the guard off; restrictAfter 0 restricts right at the nudge', () => {
    expect(lookupGuard(10, { nudgeAfter: 0, restrictAfter: 2 })).toBe('none');
    expect(lookupGuard(3, { nudgeAfter: 3, restrictAfter: 0 })).toBe('restrict');
  });

  it('switching research off keeps reply, spawn_subagent and the other tools', () => {
    expect(nonLookupTools(['reply', 'web_search', 'spawn_subagent', 'fetch_url', 'create_canvas', 'end_turn'])).toEqual(['reply', 'spawn_subagent', 'create_canvas', 'end_turn']);
  });
});
