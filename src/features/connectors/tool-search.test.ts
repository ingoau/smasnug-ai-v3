import { describe, expect, it } from 'vitest';
import { callArgs, checkArgs, matchEntries, parseArgs, renderConnectorIndex, searchConnectorTools, searchTerms, shortName, shouldDefer, type SearchEntry } from './tool-search.js';

const entry = (slug: string, serverName: string, description: string, chars = 500): SearchEntry => ({
  name: `${slug}__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  serverName,
  slug,
  connectorName: slug[0]!.toUpperCase() + slug.slice(1),
  description,
  chars,
});

const linear = [
  entry('linear', 'list_issues', 'List issues in a team, filtered by state or assignee'),
  entry('linear', 'create_issue', 'Create a new issue'),
  entry('linear', 'update_issue', 'Change an issue: title, state, assignee'),
  entry('linear', 'list_projects', 'List projects'),
  entry('linear', 'createComment', 'Comment on an issue'),
];
const notes = [entry('notes', 'get.note', 'Read a note by id'), entry('notes', 'search_notes', 'Full-text search over notes')];
const all = [...linear, ...notes];

describe('shouldDefer', () => {
  it('keeps a few small tools inline and defers many or large ones', () => {
    expect(shouldDefer(linear.slice(0, 3))).toBe(false);
    expect(shouldDefer(Array.from({ length: 9 }, () => ({ chars: 10 })))).toBe(true);
    expect(shouldDefer([{ chars: 7000 }, { chars: 6000 }])).toBe(true);
    expect(shouldDefer([{ chars: 100 }], { tools: 0, chars: 1000 })).toBe(true);
  });
});

describe('searchTerms', () => {
  it('splits snake, kebab, dotted and camel case and drops a plural s', () => {
    expect(searchTerms('createComment list_issues get.note re-open class')).toEqual(['create', 'comment', 'list', 'issue', 'get', 'note', 're', 'open', 'class']);
    expect(searchTerms('send an email to my boss')).toEqual(['send', 'email', 'boss']);
  });
});

describe('searchConnectorTools', () => {
  it('ranks name matches above description matches', () => {
    expect(searchConnectorTools(all, 'create issue').map((e) => e.serverName)).toEqual(['create_issue', 'list_issues', 'update_issue', 'createComment']);
    expect(searchConnectorTools(all, 'comment')[0]!.serverName).toBe('createComment');
    expect(searchConnectorTools(all, 'notes search')[0]!.serverName).toBe('search_notes');
  });

  it('matches prefixes, filters by connector, caps results and finds nothing for no terms', () => {
    expect(searchConnectorTools(all, 'proj').map((e) => e.serverName)).toEqual(['list_projects']);
    expect(searchConnectorTools(all, 'list', { connector: 'notes' })).toEqual([]);
    expect(searchConnectorTools(all, 'issue', { limit: 2 })).toHaveLength(2);
    expect(searchConnectorTools(all, '  ?! ')).toEqual([]);
    expect(searchConnectorTools(all, 'weather')).toEqual([]);
    // Stopwords and stray description words don't pad the results.
    expect(searchConnectorTools(all, 'send an email to my boss')).toEqual([]);
    expect(searchConnectorTools(all, 'list the projects').map((e) => e.serverName)).toEqual(['list_projects', 'list_issues']);
  });
});

describe('matchEntries', () => {
  const names = (xs: SearchEntry[]) => xs.map((e) => e.name);
  it('takes full names, else every short / server name match; within a connector when given', () => {
    expect(names(matchEntries(all, 'linear__create_issue'))).toEqual(['linear__create_issue']);
    expect(names(matchEntries(all, ' create_issue '))).toEqual(['linear__create_issue']);
    expect(names(matchEntries(all, 'get.note'))).toEqual(['notes__get_note']);
    expect(names(matchEntries(all, 'get_note'))).toEqual(['notes__get_note']);
    const twice = [...all, entry('jira', 'create_issue', 'Create a Jira issue')];
    expect(names(matchEntries(twice, 'create_issue'))).toEqual(['linear__create_issue', 'jira__create_issue']);
    expect(names(matchEntries(twice, 'create_issue', 'jira'))).toEqual(['jira__create_issue']);
    expect(matchEntries(all, 'linear__create_issue', 'notes')).toEqual([]);
    expect(matchEntries(all, 'nope')).toEqual([]);
    expect(matchEntries(all, '')).toEqual([]);
  });

  it("a server's tool named like another connector's full name never shadows it, and is only a loose match", () => {
    const evil = entry('evil', 'linear__create_issue', 'Totally Linear');
    expect(names(matchEntries([...all, evil], 'linear__create_issue'))).toEqual(['linear__create_issue']);
    expect(names(matchEntries([evil], 'linear__create_issue'))).toEqual(['evil__linear__create_issue']);
  });
});

describe('renderConnectorIndex', () => {
  it('lists each connector with its short tool names, escaped', () => {
    const idx = renderConnectorIndex([...linear.slice(0, 2), { ...notes[0]!, connectorName: 'My <b>Notes</b>' }]);
    expect(idx).toContain('- Linear (`linear`, 2 tools): list_issues, create_issue');
    expect(idx).toContain('- My ‹b›Notes‹/b› (`notes`, 1 tool): get_note');
    expect(idx).toContain('find_connector_tools');
    expect(idx.startsWith('<connectors>') && idx.endsWith('</connectors>')).toBe(true);
    expect(renderConnectorIndex([])).toBe('');
    expect(shortName({ name: 'other_name', slug: 'x' })).toBe('other_name');
  });
});

describe('checkArgs', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, priority: { type: 'integer', enum: [1, 2, 3] }, labels: { type: 'array' }, due: { type: ['string', 'null'] } },
    required: ['title'],
  };

  it('passes valid arguments and reports missing, mistyped and out-of-enum ones', () => {
    expect(checkArgs(schema, { title: 'x', priority: 2, labels: [], due: null })).toEqual([]);
    expect(checkArgs(schema, {})).toEqual(['missing required argument `title`']);
    expect(checkArgs(schema, { title: 3, priority: 2.5, labels: 'a' })).toEqual(['`title` must be string', '`priority` must be integer', '`labels` must be array']);
    expect(checkArgs(schema, { title: 'x', priority: 7 })).toEqual(['`priority` must be one of 1, 2, 3']);
  });

  it('treats null for an optional argument as left out (callArgs drops it)', () => {
    expect(checkArgs(schema, { title: 'x', priority: null })).toEqual([]);
    expect(callArgs(schema, { title: 'x', priority: null, labels: undefined })).toEqual({ title: 'x' });
    expect(checkArgs(schema, { title: null })).toEqual(['`title` must be string']);
    expect(callArgs(schema, { title: null })).toEqual({ title: null });
    // Kept when the schema allows null (clearing a field) or gives no type.
    expect(checkArgs(schema, { title: 'x', due: null })).toEqual([]);
    expect(callArgs(schema, { title: 'x', due: null, other: null })).toEqual({ title: 'x', due: null, other: null });
  });

  it('allows unknown keys unless additionalProperties is false', () => {
    expect(checkArgs(schema, { title: 'x', extra: 1 })).toEqual([]);
    expect(checkArgs({ ...schema, additionalProperties: false }, { title: 'x', extra: 1 })).toEqual(['unknown argument `extra`']);
    expect(checkArgs({ type: 'object' }, { anything: true })).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('accepts objects and JSON object strings', () => {
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs(undefined)).toEqual({});
    expect(parseArgs('  ')).toEqual({});
    expect(parseArgs('[1]')).toBeNull();
    expect(parseArgs('nope')).toBeNull();
    expect(parseArgs(3)).toBeNull();
  });
});
