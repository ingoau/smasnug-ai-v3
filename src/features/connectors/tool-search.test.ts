import { describe, expect, it } from 'vitest';
import { checkArgs, parseArgs, renderConnectorIndex, resolveEntry, searchConnectorTools, searchTerms, shortName, shouldDefer, type SearchEntry } from './tool-search.js';

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
  });
});

describe('resolveEntry', () => {
  it('takes full names, short names and server names; ambiguous or unknown → null', () => {
    expect(resolveEntry(all, 'linear__create_issue')?.serverName).toBe('create_issue');
    expect(resolveEntry(all, ' create_issue ')?.serverName).toBe('create_issue');
    expect(resolveEntry(all, 'get.note')?.name).toBe('notes__get_note');
    expect(resolveEntry(all, 'get_note')?.name).toBe('notes__get_note');
    const twice = [...all, entry('jira', 'create_issue', 'Create a Jira issue')];
    expect(resolveEntry(twice, 'create_issue')).toBeNull();
    expect(resolveEntry(twice, 'create_issue', 'jira')?.slug).toBe('jira');
    expect(resolveEntry(all, 'nope')).toBeNull();
    expect(resolveEntry(all, '')).toBeNull();
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
