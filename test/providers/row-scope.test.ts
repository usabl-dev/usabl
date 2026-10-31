/**
 * Row scope is read from the live page after the providers ran, and it is what lets the gate key a
 * control in one table row apart from the same control in the next row.
 *
 * The row is named by text the page shows, such as a job name or a host name, which is often
 * customer data. That text never reaches a draft, a finding, or the committed floor: only a hash of
 * it does. The same holds for the table's identity, which can carry an id or a caption.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, Page, RowContextRead } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { attachRowScopeToDrafts, readFocusedRow } from '../../src/providers/row-scope.js';

function draft(over: Partial<Draft> = {}): Draft {
  return {
    rule: 'button-name', layer: 'axe', severity: 'critical', evidenceClass: 'deterministic',
    screenId: 'jobs', elementPath: 'tr:nth-child(2) > td:nth-child(4) > button', elementName: null,
    role: null, whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
    ...over,
  };
}

const SCREEN = { id: 'jobs', url: 'http://app.test/jobs' };

function pageWith(read: (selector: string) => Promise<RowContextRead>): Page {
  return makeFakePage({ rowContext: read });
}

const ALPHA: Extract<RowContextRead, { kind: 'keyed' }> = {
  kind: 'keyed',
  table: '[["attr:id","jobs-for-example-corp"]]',
  source: 'header',
  key: 'nightly-backup.prod.example.com',
  role: 'button',
  path: 'td:nth-child(4) > button:nth-child(1)',
  otherKeys: [],
  otherTables: [],
};

function rowScopeOf(d: Draft): Record<string, unknown> {
  const scope = d.evidence.extra?.['rowScope'];
  if (typeof scope !== 'object' || scope === null) {
    throw new Error('expected a row scope');
  }
  return scope as Record<string, unknown>;
}

describe('attachRowScopeToDrafts', () => {
  const attach = async (read: (selector: string) => Promise<RowContextRead>, drafts: Draft[] = [draft()]) =>
    attachRowScopeToDrafts(pageWith(read), SCREEN, drafts);

  it('records a hashed row token, never the row text', async () => {
    const [out] = (await attach(async () => ALPHA)).drafts;
    const scope = rowScopeOf(out!);
    expect(scope['row']).toMatch(/^[0-9a-f]{16}$/);
    expect(scope['role']).toBe('button');
    expect(scope['path']).toBe('td:nth-child(4)>button:nth-child(1)');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('nightly');
    expect(serialized).not.toContain('example');
  });

  it('hashes the table identity, so a table id that holds page text is not kept', async () => {
    const [out] = (await attach(async () => ALPHA)).drafts;
    expect(rowScopeOf(out!)['table']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(out)).not.toContain('example-corp');
  });

  it('gives rows whose keys differ only in case or spacing different tokens', async () => {
    // The page reader tells rows apart by their exact keys, so the token must keep every difference
    // it saw. Folding case here once made two rows the reader told apart share one token.
    const [a] = (await attach(async () => ALPHA)).drafts;
    const [b] = (await attach(async () => ({ ...ALPHA, key: 'Nightly-Backup.prod.example.com' }))).drafts;
    const [c] = (await attach(async () => ({ ...ALPHA, key: ' nightly-backup.prod.example.com' }))).drafts;
    expect(rowScopeOf(a!)['row']).not.toBe(rowScopeOf(b!)['row']);
    expect(rowScopeOf(a!)['row']).not.toBe(rowScopeOf(c!)['row']);
  });

  it('gives the same row the same token on another read', async () => {
    const [a] = (await attach(async () => ALPHA)).drafts;
    const [b] = (await attach(async () => ({ ...ALPHA }))).drafts;
    expect(rowScopeOf(a!)['row']).toBe(rowScopeOf(b!)['row']);
  });

  it('gives a different token to a row named the same text by a key attribute', async () => {
    const [a] = (await attach(async () => ALPHA)).drafts;
    const [b] = (await attach(async () => ({ ...ALPHA, source: 'attr:data-row-key' }))).drafts;
    expect(rowScopeOf(a!)['row']).not.toBe(rowScopeOf(b!)['row']);
  });

  it('folds a role a page wrote into a key token', async () => {
    const [out] = (await attach(async () => ({ ...ALPHA, role: 'Menu Item\u202e' }))).drafts;
    expect(rowScopeOf(out!)['role']).toBe('menu-item');
  });

  it('leaves a draft alone, with no gap, when the control is not in a keyed row', async () => {
    const original = draft();
    const out = await attach(async () => ({ kind: 'none' }), [original]);
    expect(out.drafts).toEqual([original]);
    expect(out.gaps).toEqual([]);
  });

  it('keeps the finding when the page cannot be read, and reports a gap', async () => {
    const original = draft();
    const out = await attach(async () => {
      throw new Error('selector matched nothing');
    }, [original]);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]!.evidence).toEqual(original.evidence);
    expect(out.gaps).toHaveLength(1);
  });

  it('keeps every other evidence field', async () => {
    const original = draft({ evidence: { extra: { html: '<button></button>' } } });
    const [out] = (await attach(async () => ALPHA, [original])).drafts;
    expect(out!.evidence.extra?.['html']).toBe('<button></button>');
  });

  it('asks nothing of the page for a draft with no element path', async () => {
    let asked = 0;
    await attach(async () => {
      asked += 1;
      return ALPHA;
    }, [draft({ elementPath: '' })]);
    expect(asked).toBe(0);
  });
});

// Two keys a provider leaves on a draft for the row read: a target for an element past a frame or a
// shadow root, and a row the provider already read at the element. Both are read and removed.
describe('attachRowScopeToDrafts with a target or a carried row', () => {
  it('reads the row through the target, not the joined element path', async () => {
    const seen: unknown[] = [];
    const page = makeFakePage({
      rowContext: async (target) => {
        seen.push(target);
        return ALPHA;
      },
    });
    const target = [['x-row-actions'], ['button']];
    const out = await attachRowScopeToDrafts(page, SCREEN, [
      draft({ elementPath: 'x-row-actions,button', evidence: { extra: { html: '<button>', rowTarget: target } } }),
    ]);
    expect(seen).toEqual([target]);
    expect(out.gaps).toEqual([]);
    expect(rowScopeOf(out.drafts[0]!)['row']).toMatch(/^[0-9a-f]{16}$/);
    expect(out.drafts[0]!.evidence.extra?.['rowTarget']).toBeUndefined();
    expect(out.drafts[0]!.evidence.extra?.['html']).toBe('<button>');
  });

  it('reads a target that is not a list of selector lists as a failed read, with a gap', async () => {
    let asked = false;
    const page = makeFakePage({
      rowContext: async () => {
        asked = true;
        return { kind: 'none' };
      },
    });
    const out = await attachRowScopeToDrafts(page, SCREEN, [draft({ evidence: { extra: { rowTarget: ['button', 7] } } })]);
    expect(asked).toBe(false);
    expect(out.drafts[0]!.confidence).toBe('unverified');
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.reason).toContain('could not read the row');
  });

  it('uses a carried row scope without reading the page again', async () => {
    let asked = false;
    const page = makeFakePage({
      rowContext: async () => {
        asked = true;
        return { kind: 'unreadable', reason: 'element-missing' };
      },
    });
    const rowScope = { table: 'a'.repeat(16), row: 'b'.repeat(16), role: 'button', path: 'td:nth-child(2)>button:nth-child(1)' };
    const out = await attachRowScopeToDrafts(page, SCREEN, [
      draft({ elementPath: 'tab-stop-3', evidence: { extra: { rowRead: { kind: 'scoped', rowScope } } } }),
    ]);
    expect(asked).toBe(false);
    expect(out.gaps).toEqual([]);
    expect(out.drafts[0]!.evidence).toEqual({ extra: { rowScope } });
  });

  it('leaves a draft with a carried row of none as it was, with no extra record left behind', async () => {
    const out = await attachRowScopeToDrafts(makeFakePage(), SCREEN, [
      draft({ elementPath: 'tab-stop-0', evidence: { extra: { rowRead: { kind: 'none' } } } }),
    ]);
    expect(out.gaps).toEqual([]);
    expect(out.drafts[0]).toEqual(draft({ elementPath: 'tab-stop-0' }));
  });

  it('discloses a carried reason as a gap and marks the finding unverified', async () => {
    const out = await attachRowScopeToDrafts(makeFakePage(), SCREEN, [
      draft({ evidence: { extra: { rowRead: { kind: 'unkeyed', reason: 'frame-unreadable' } } } }),
    ]);
    expect(out.drafts[0]!.confidence).toBe('unverified');
    expect(out.gaps[0]!.reason).toContain('frame usabl could not look inside');
  });

  it('reads a carried row of any other shape as a failed read, never as no row', async () => {
    const shapes: unknown[] = [
      'none',
      { kind: 'scoped', rowScope: { table: 't', row: '', role: 'button', path: '' } },
      { kind: 'unkeyed', reason: 'banana' },
      { kind: 'keyed' },
    ];
    for (const rowRead of shapes) {
      const out = await attachRowScopeToDrafts(makeFakePage(), SCREEN, [draft({ evidence: { extra: { rowRead } } })]);
      expect(out.drafts[0]!.confidence).toBe('unverified');
      expect(out.gaps).toHaveLength(1);
    }
  });
});

describe('readFocusedRow', () => {
  it('hashes the focused row at once and keeps no row text', async () => {
    const row = await readFocusedRow(makeFakePage({ focusedRowContext: async () => ALPHA }));
    expect(row.kind).toBe('scoped');
    expect(JSON.stringify(row)).not.toContain('nightly');
  });

  it('carries a read that throws as a failed read, never as no row', async () => {
    const row = await readFocusedRow(
      makeFakePage({
        focusedRowContext: async () => {
          throw new Error('page closed');
        },
      }),
    );
    expect(row).toEqual({ kind: 'unkeyed', reason: 'read-failed' });
  });
});
