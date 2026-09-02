/**
 * axe reports four buckets per run and the engine used to keep two of them. `passes` and
 * `inapplicable` are the record of what axe checked and what it never matched, which is the
 * only way "checked and found nothing" can be told apart from "never applied here".
 *
 * The raw axe object is untyped input, so the mapping is defensive: a shape that is not an array
 * yields nothing rather than a throw. Only a missing rule id can drop an entry, because only the
 * rule id is part of the record. A field the record does not carry must never decide what it holds.
 */
import { describe, expect, it } from 'vitest';
import { mapAxeRuleSummaries } from '../../src/deps/real.js';

describe('mapAxeRuleSummaries', () => {
  it('keeps the rule id and the number of nodes the rule matched', () => {
    const summaries = mapAxeRuleSummaries([
      {
        id: 'html-has-lang',
        description: 'The html element must have a lang attribute.',
        nodes: [{ target: ['html'] }, { target: ['html'] }],
      },
    ]);

    expect(summaries).toEqual([{ id: 'html-has-lang', nodeCount: 2 }]);
  });

  it('reads the node array length for an inapplicable rule instead of assuming zero', () => {
    const summaries = mapAxeRuleSummaries([{ id: 'video-caption', nodes: [] }]);

    expect(summaries[0]?.nodeCount).toBe(0);
  });

  it('reports zero nodes when the entry carries no node array at all', () => {
    const summaries = mapAxeRuleSummaries([{ id: 'video-caption' }]);

    expect(summaries[0]?.nodeCount).toBe(0);
  });

  it('keeps a rule that carries no description, because the record carries none either', () => {
    const summaries = mapAxeRuleSummaries([
      { id: 'video-caption', nodes: [] },
      { id: 'html-has-lang', description: 'The html element must have a lang attribute.', nodes: [] },
    ]);

    expect(summaries.map((summary) => summary.id)).toEqual(['video-caption', 'html-has-lang']);
  });

  it('skips an entry with no id, because the id is the whole identity of the record', () => {
    const summaries = mapAxeRuleSummaries([
      { description: 'No id here.', nodes: [] },
      { id: 'kept', nodes: [] },
    ]);

    expect(summaries.map((summary) => summary.id)).toEqual(['kept']);
  });

  it('returns nothing when the input is not an array', () => {
    expect(mapAxeRuleSummaries(undefined)).toEqual([]);
    expect(mapAxeRuleSummaries({ id: 'not-an-array' })).toEqual([]);
  });
});
