import { describe, expect, it } from 'vitest';
import { chartsFallback, normalizeCharts, storedCharts } from './charts.js';

const bar = {
  title: 'Weekly signups',
  type: 'bar',
  series: [{ name: 'Signups', data: [{ label: 'Mon', value: 10 }, { label: 'Tue', value: 12 }] }],
  x_label: 'Day',
  y_label: 'Count',
};

describe('normalizeCharts', () => {
  it('builds a pie and a bar within Slack limits', () => {
    const { blocks, notes } = normalizeCharts([
      { title: 'Candy', type: 'pie', segments: [{ label: 'Kit Kat', value: 45 }, { label: 'Twix', value: '28' }, { label: 'Empty', value: 0 }] },
      bar,
    ]);
    expect(notes).toEqual([]);
    expect(blocks).toEqual([
      { type: 'data_visualization', title: 'Candy', chart: { type: 'pie', segments: [{ label: 'Kit Kat', value: 45 }, { label: 'Twix', value: 28 }] } },
      {
        type: 'data_visualization',
        title: 'Weekly signups',
        chart: {
          type: 'bar',
          series: [{ name: 'Signups', data: [{ label: 'Mon', value: 10 }, { label: 'Tue', value: 12 }] }],
          axis_config: { categories: ['Mon', 'Tue'], x_label: 'Day', y_label: 'Count' },
        },
      },
    ]);
  });

  it('accepts Slack\'s nested chart object and keeps negative line values', () => {
    const { blocks, notes } = normalizeCharts({
      title: 'Delta',
      chart: {
        type: 'line',
        series: [{ name: 'Change', data: [{ label: 'W1', value: -2 }, { label: 'W2', value: 4 }] }],
        axis_config: { categories: ['W1', 'W2'], y_label: 'Δ' },
      },
    });
    expect(notes).toEqual([]);
    expect(blocks[0]!.chart).toMatchObject({ type: 'line', axis_config: { categories: ['W1', 'W2'], y_label: 'Δ' } });
    expect(blocks[0]!.chart).toMatchObject({ series: [{ data: [{ value: -2 }, { value: 4 }] }] });
  });

  it('drops a series that skips a category, and a chart that then has none', () => {
    const partial = normalizeCharts({
      title: 'Regions',
      type: 'area',
      categories: ['Mon', 'Tue'],
      series: [
        { name: 'EU', data: [{ label: 'Mon', value: 1 }, { label: 'Tue', value: 2 }] },
        { name: 'US', data: [{ label: 'Mon', value: 3 }] },
      ],
    });
    expect(partial.blocks[0]!.chart).toMatchObject({ type: 'area', series: [{ name: 'EU' }] });
    expect(partial.notes[0]).toMatch(/left out series missing a category: US/);
    const gone = normalizeCharts({ title: 'Regions', type: 'bar', categories: ['Mon', 'Tue'], series: [{ name: 'US', data: [{ label: 'Mon', value: 3 }] }] });
    expect(gone.blocks).toEqual([]);
    expect(gone.notes[0]).toMatch(/Dropped bar chart "Regions"/);
  });

  it('caps at 2 charts, 20-character labels, and a title of 50', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz';
    const { blocks, notes } = normalizeCharts([
      { title: long.repeat(3), type: 'pie', segments: [{ label: long, value: 1 }, { label: 'b', value: 1 }] },
      bar,
      { title: 'Third', type: 'pie', segments: [{ label: 'a', value: 1 }] },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.title).toHaveLength(50);
    const pie = blocks[0]!.chart;
    expect(pie.type).toBe('pie');
    if (pie.type === 'pie') expect(pie.segments[0]!.label).toHaveLength(20);
    expect(notes).toEqual(['Only the first 2 charts fit in one Slack message.']);
  });

  it('neutralises group pings in titles and drops a chart with no title or no positive slices', () => {
    const { blocks, notes } = normalizeCharts([
      { title: 'hi <!channel>', type: 'pie', segments: [{ label: '@here', value: 1 }] },
      { type: 'pie', segments: [{ label: 'a', value: 1 }] },
      { title: 'Nope', type: 'pie', segments: [{ label: 'a', value: 0 }] },
      { title: 'Mystery', type: 'scatter', series: [] },
    ]);
    expect(JSON.stringify(blocks)).not.toMatch(/<!(channel|here)/);
    expect(blocks[0]!.title).toContain('@​channel');
    expect(blocks).toHaveLength(1);
    expect(notes.map((n) => n.replace(/"/g, '')).join(' ')).toMatch(/no title/);
    expect(notes.join(' ')).toMatch(/Nope/);
    expect(notes.join(' ')).toMatch(/Mystery/);
  });
});

describe('storedCharts', () => {
  it('puts axis fields back to Slack snake_case after a postgres camelCase read', () => {
    const { blocks } = normalizeCharts([bar]);
    const camel = JSON.parse(JSON.stringify(blocks).replaceAll('axis_config', 'axisConfig').replaceAll('x_label', 'xLabel').replaceAll('y_label', 'yLabel'));
    expect(storedCharts(camel)).toEqual(blocks);
    expect(JSON.stringify(storedCharts(camel))).toContain('axis_config');
    expect(JSON.stringify(storedCharts(camel))).not.toContain('axisConfig');
  });
});

describe('chartsFallback', () => {
  it('keeps the reply text and appends a one-line summary while there is room', () => {
    const { blocks } = normalizeCharts([bar]);
    expect(chartsFallback('signups are up', blocks)).toBe('signups are up\nWeekly signups (bar): Signups: Mon 10, Tue 12');
    expect(chartsFallback('', blocks)).toBe('Weekly signups (bar): Signups: Mon 10, Tue 12');
    expect(chartsFallback('signups are up', [])).toBe('signups are up');
  });
});
