/**
 * A finding that sits in a table row whose identity cannot be read, or that two rows share, is not
 * keyed by row. That is not the same as a finding outside any row. Outside a row the old keys are
 * all there is and nothing was lost. Inside a row that cannot be told apart, the old key collapses
 * this row with its neighbours, where a new barrier can fill an accepted count and read as carried.
 * So the scan says it could not tell the rows apart, as a not-covered gap that names the screen and
 * the rule and never a key.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, Page, RowContextRead } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { attachRowScopeToDrafts } from '../../src/providers/row-scope.js';

const SCREEN = { id: 'jobs', url: 'http://app.test/jobs' };

function draft(path: string, rule = 'button-name'): Draft {
  return {
    rule, layer: 'axe', severity: 'critical', evidenceClass: 'deterministic',
    screenId: 'jobs', elementPath: path, elementName: null, role: null,
    whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
  };
}

const KEYED: RowContextRead = {
  kind: 'keyed',
  table: '[["caption","Customer jobs for acme-corp"]]',
  source: 'attr:data-row-key',
  key: 'acme-corp-backup',
  role: 'button',
  path: 'td:nth-child(2) > button:nth-child(1)',
};

function pageAnswering(answers: Record<string, RowContextRead | Error>): Page {
  return makeFakePage({
    rowContext: async (selector: string) => {
      const answer = answers[selector];
      if (answer instanceof Error) throw answer;
      return answer ?? { kind: 'none' };
    },
  });
}

describe('row scope when a row cannot be told apart', () => {
  it('keys a row with a unique key, and hashes the table and the row so no page text is kept', async () => {
    const out = await attachRowScopeToDrafts(pageAnswering({ '#a': KEYED }), SCREEN, [draft('#a')]);
    expect(out.gaps).toEqual([]);
    const scope = out.drafts[0]!.evidence.extra?.['rowScope'] as Record<string, string>;
    expect(scope['table']).toMatch(/^[0-9a-f]{16}$/);
    expect(scope['row']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(out)).not.toContain('acme');
  });

  it('keeps a finding outside any row on its old key with no gap', async () => {
    const out = await attachRowScopeToDrafts(pageAnswering({}), SCREEN, [draft('#outside')]);
    expect(out.gaps).toEqual([]);
    expect(out.drafts[0]!.evidence).toEqual({});
  });

  it('reports a gap by screen and rule for a row whose key another row shares', async () => {
    const out = await attachRowScopeToDrafts(
      pageAnswering({ '#a': { kind: 'ambiguous', reason: 'row-key-duplicate' } }),
      SCREEN,
      [draft('#a')],
    );
    expect(out.drafts[0]!.evidence).toEqual({});
    // Which accepted barrier it is cannot be known, so it is not claimed as a definite new one.
    expect(out.drafts[0]!.confidence).toBe('unverified');
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.state).toBe('not-covered');
    expect(out.gaps[0]!.reason).toContain('screen jobs, rule button-name');
    expect(out.gaps[0]!.reason).toContain('share a key');
  });

  it('reports a gap for unkeyed rows in a table whose other rows are keyed, and keys the keyed ones', async () => {
    const out = await attachRowScopeToDrafts(
      pageAnswering({ '#keyed': KEYED, '#unkeyed': { kind: 'ambiguous', reason: 'row-key-missing' } }),
      SCREEN,
      [draft('#keyed'), draft('#unkeyed')],
    );
    expect(out.drafts[0]!.evidence.extra?.['rowScope']).toBeDefined();
    expect(out.drafts[1]!.evidence).toEqual({});
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.reason).toContain('1 barrier');
    expect(out.gaps[0]!.reason).toContain('has no key');
  });

  it('reports a gap when the row read throws, and keeps the finding', async () => {
    const out = await attachRowScopeToDrafts(
      pageAnswering({ '#a': new Error('Execution context was destroyed') }),
      SCREEN,
      [draft('#a', 'pf-icon-button-name')],
    );
    expect(out.drafts).toHaveLength(1);
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.reason).toContain('screen jobs, rule pf-icon-button-name');
    expect(out.gaps[0]!.reason).toContain('could not read');
    // The error text is not usabl's to repeat, and it is not needed to act on the gap.
    expect(out.gaps[0]!.reason).not.toContain('Execution context');
  });

  it('reports one gap per rule, counting every barrier under it', async () => {
    const ambiguous: RowContextRead = { kind: 'ambiguous', reason: 'table-ambiguous' };
    const out = await attachRowScopeToDrafts(
      pageAnswering({ '#a': ambiguous, '#b': ambiguous, '#c': ambiguous }),
      SCREEN,
      [draft('#a'), draft('#b'), draft('#c', 'color-contrast')],
    );
    expect(out.gaps.map((g) => g.reason.match(/rule ([a-z-]+): (\d+)/)?.slice(1))).toEqual([
      ['button-name', '2'],
      ['color-contrast', '1'],
    ]);
  });
});

describe('row scope when the element cannot be found again', () => {
  // The scanner named an element, and by the time its row is read the selector no longer finds
  // exactly that one element. Whether it sat in a keyed row is unknown, so it is disclosed. Reading
  // it as outside a row would key it the old way, where a version 2 count floor carries it.
  for (const [reason, words] of [
    ['element-missing', 'could not find the element again'],
    ['element-multiple', 'matched more than one element'],
    ['selector-invalid', 'could not use the selector'],
  ] as const) {
    it(`reports a gap and keeps the finding unkeyed when the read is ${reason}`, async () => {
      const out = await attachRowScopeToDrafts(
        pageAnswering({ '#a': { kind: 'unreadable', reason } as unknown as RowContextRead }),
        SCREEN,
        [draft('#a')],
      );
      expect(out.drafts[0]!.evidence).toEqual({});
      expect(out.drafts[0]!.confidence).toBe('unverified');
      expect(out.gaps).toHaveLength(1);
      expect(out.gaps[0]!.state).toBe('not-covered');
      expect(out.gaps[0]!.reason).toContain('screen jobs, rule button-name');
      expect(out.gaps[0]!.reason).toContain(words);
    });
  }
});

describe('row scope when two hashes collide', () => {
  // Uniqueness is checked on the exact text, and only 16 hex characters of its hash are kept. Two
  // different keys that share those 16 characters would share one identity, so the tokens are
  // checked again after hashing. A hash that maps everything to one value forces the collision.
  const collide = (): string => '0'.repeat(64);

  it('treats a row whose token another row of its table shares as ambiguous', async () => {
    const read = { ...KEYED, otherKeys: ['acme-corp-restore'], otherTables: [] } as RowContextRead;
    const out = await attachRowScopeToDrafts(pageAnswering({ '#a': read }), SCREEN, [draft('#a')], { hash: collide });
    expect(out.drafts[0]!.evidence).toEqual({});
    expect(out.drafts[0]!.confidence).toBe('unverified');
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.reason).toContain('screen jobs, rule button-name');
    expect(out.gaps[0]!.reason).toContain('same short hash');
    expect(JSON.stringify(out)).not.toContain('acme');
  });

  it('treats a row whose table token another table on the screen shares as ambiguous', async () => {
    // Only table names collide here: the row hash is left distinct.
    const tableOnly = (value: string): string => (value.includes('"table"') ? '1'.repeat(64) : value.length.toString(16).padStart(64, 'a'));
    const read = { ...KEYED, otherKeys: [], otherTables: ['[["caption","Other jobs"]]'] } as RowContextRead;
    const out = await attachRowScopeToDrafts(pageAnswering({ '#a': read }), SCREEN, [draft('#a')], { hash: tableOnly });
    expect(out.drafts[0]!.evidence).toEqual({});
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.reason).toContain('same short hash');
  });

  it('keys the row when no token collides', async () => {
    const read = { ...KEYED, otherKeys: ['acme-corp-restore'], otherTables: ['[["caption","Other jobs"]]'] } as RowContextRead;
    const out = await attachRowScopeToDrafts(pageAnswering({ '#a': read }), SCREEN, [draft('#a')]);
    expect(out.gaps).toEqual([]);
    expect(out.drafts[0]!.evidence.extra?.['rowScope']).toBeDefined();
  });
});
