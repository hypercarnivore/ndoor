import { describe, expect, it } from 'vitest';
import { formatTable, REPORTS, reportNames } from '../src/lib/reports.js';

describe('reports', () => {
  it('every report has a description and takes $limit', () => {
    expect(reportNames()).toEqual(Object.keys(REPORTS));
    for (const [name, report] of Object.entries(REPORTS)) {
      expect(report.description, name).not.toBe('');
      expect(report.cypher, name).toContain('$limit');
    }
  });

  it('formats rows as an aligned table', () => {
    const table = formatTable([
      { name: 'Ann', at: new Date('2026-10-11T08:00:00Z'), tags: ['a', 'b'], note: null },
      { name: 'Bartholomew', at: null, tags: [], note: `long ${'x'.repeat(100)}` },
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toBe('name         at          tags  note');
    expect(lines[1]).toMatch(/^-{11} {2}-{10}/);
    expect(lines[2]).toBe('Ann          2026-10-11  a, b');
    expect(lines[3].endsWith('…')).toBe(true);
    expect(lines[3].length).toBeLessThan(110);
  });

  it('strips control characters from cells and handles empty results', () => {
    expect(formatTable([{ text: 'evil\u001b]0;title\u0007 text' }])).not.toMatch(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control characters are gone
      /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/,
    );
    expect(formatTable([])).toBe('(no rows)');
  });
});
