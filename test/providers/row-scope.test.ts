/**
 * Row scope is read from the live page after the providers ran, and it is what lets the gate key a
 * control in one table row apart from the same control in the next row.
 *
 * The row is named by text the page shows, such as a job name or a host name, which is often
 * customer data. That text never reaches a draft, a finding, or the committed floor: only a hash of
 * it does.
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

function pageWith(read: (selector: string) => Promise<RowContextRead | null>): Page {
  return makeFakePage({ rowContext: read });
}

const ALPHA: RowContextRead = {
  table: 'html > body > main:nth-child(1) > table#jobs-\\:r3\\:',
  source: 'header',
  text: 'nightly-backup.prod.example.com',
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
  it('records a hashed row token, never the row text', async () => {
    const [out] = await attachRowScopeToDrafts(pageWith(async () => ALPHA), [draft()]);
    const scope = rowScopeOf(out!);
    expect(scope['row']).toMatch(/^[0-9a-f]{16}$/);
    expect(scope['role']).toBe('button');
    expect(scope['path']).toBe('td:nth-child(4)>button:nth-child(1)');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('nightly');
    expect(serialized).not.toContain('example');
  });

  it('neutralizes the table path the same way structural keys are neutralized', async () => {
    const [out] = await attachRowScopeToDrafts(pageWith(async () => ALPHA), [draft()]);
    expect(rowScopeOf(out!)['table']).toBe('html>body>main>table#jobs-{generated-id}');
  });

  it('gives the same row the same token when only case and spacing differ', async () => {
    const [a] = await attachRowScopeToDrafts(pageWith(async () => ALPHA), [draft()]);
    const [b] = await attachRowScopeToDrafts(
      pageWith(async () => ({ ...ALPHA, text: '  Nightly-Backup.PROD.example.com \n' })),
      [draft()],
    );
    expect(rowScopeOf(a!)['row']).toBe(rowScopeOf(b!)['row']);
  });

  it('gives a different token to a row named the same text by a key attribute', async () => {
    const [a] = await attachRowScopeToDrafts(pageWith(async () => ALPHA), [draft()]);
    const [b] = await attachRowScopeToDrafts(
      pageWith(async () => ({ ...ALPHA, source: 'attr:data-row-key' })),
      [draft()],
    );
    expect(rowScopeOf(a!)['row']).not.toBe(rowScopeOf(b!)['row']);
  });

  it('folds a role a page wrote into a key token', async () => {
    const [out] = await attachRowScopeToDrafts(
      pageWith(async () => ({ ...ALPHA, role: 'Menu Item\u202e' })),
      [draft()],
    );
    expect(rowScopeOf(out!)['role']).toBe('menu-item');
  });

  it('leaves a draft alone when the control is not in a keyed row', async () => {
    const original = draft();
    const [out] = await attachRowScopeToDrafts(pageWith(async () => null), [original]);
    expect(out).toEqual(original);
  });

  it('leaves a draft alone when the row text is blank', async () => {
    const original = draft();
    const [out] = await attachRowScopeToDrafts(pageWith(async () => ({ ...ALPHA, text: '   ' })), [original]);
    expect(out).toEqual(original);
  });

  it('keeps the finding and drops only the row scope when the page cannot be read', async () => {
    const original = draft();
    const [out] = await attachRowScopeToDrafts(
      pageWith(async () => {
        throw new Error('selector matched nothing');
      }),
      [original],
    );
    expect(out).toEqual(original);
  });

  it('keeps every other evidence field', async () => {
    const original = draft({ evidence: { extra: { html: '<button></button>' } } });
    const [out] = await attachRowScopeToDrafts(pageWith(async () => ALPHA), [original]);
    expect(out!.evidence.extra?.['html']).toBe('<button></button>');
  });

  it('asks nothing of the page for a draft with no element path', async () => {
    let asked = 0;
    const original = draft({ elementPath: '' });
    await attachRowScopeToDrafts(
      pageWith(async () => {
        asked += 1;
        return ALPHA;
      }),
      [original],
    );
    expect(asked).toBe(0);
  });
});
