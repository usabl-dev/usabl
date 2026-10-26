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
import { attachRowScopeToDrafts } from '../../src/providers/row-scope.js';

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
