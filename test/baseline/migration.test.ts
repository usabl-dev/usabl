/**
 * `usabl baseline` is the command that replaces an old floor. The gaps the gate raises because the
 * committed floor is old, the version 1 placeholder counts and the version 2 floor that predates
 * row keys, are about that floor, so they must not stop the baseline that replaces it. A real
 * measurement gap still does.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Draft, ScreenScan } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';
import { testConfig } from '../helpers.js';

function buttonInRow(row: string): Draft {
  return {
    rule: 'pf-icon-button-name', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'main > table > tbody > tr > td > button', elementName: null, role: 'button',
    whatUserExperiences: '', why: '', fix: '',
    evidence: { extra: { rowScope: { table: '0000000000000000', row, role: 'button', path: 'td:nth-child(2)>button:nth-child(1)' } } },
    confidence: 'fail',
  };
}

const named: Draft = {
  rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
  screenId: 'clusters', elementPath: 'main > p', elementName: 'Save', role: 'button',
  whatUserExperiences: '', why: '', fix: '', evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};

function scan(drafts: Draft[], gaps: ScreenScan['gaps'] = []): ScreenScan {
  return { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', stops: [], drafts, gaps, applicability: [], reachedSelectorPresent: null };
}

function depsWith(floor: unknown, scans: ScreenScan[]): Deps {
  const files = {
    'usabl.config.json': '{}',
    'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
    '.usabl-evidence.json': JSON.stringify(floor),
  };
  const base = makeFakeDeps({ files, headContents: files });
  let calls = 0;
  return { ...base, checkRunner: { scan: async () => scans[Math.min(calls++, scans.length - 1)]! } };
}

async function baseline(deps: Deps) {
  let written: string | null = null;
  const outcome = await runBaseline(deps, testConfig(), { writeFile: async (_p, c) => { written = c; } });
  return { outcome, written: written as string | null };
}

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

describe('baseline over an old floor', () => {
  it('replaces a version 2 floor with keyed rows by a complete version 3 floor', async () => {
    const v2 = { version: 2, entries: [{ screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: null, identityBasis: 'count', count: 2 }] };
    const { outcome, written } = await baseline(depsWith(v2, [scan([buttonInRow(A), buttonInRow(B)])]));
    expect(outcome.exitCode).toBe(0);
    const floor = parseEvidenceFloor(JSON.parse(written ?? ''));
    expect(floor.version).toBe(3);
    expect(floor.scope).toBeUndefined();
    expect(floor.entries.map((e) => e.identityBasis)).toEqual(['row', 'row']);
  });

  it('replaces a version 1 floor with placeholder counts by a complete version 3 floor', async () => {
    const v1 = { version: 1, entries: [{ screenId: 'clusters', layer: 'axe', rule: 'color-contrast', elementKey: 'clusters|color-contrast|name:save', identityBasis: 'name', count: 1 }] };
    const { outcome, written } = await baseline(depsWith(v1, [scan([named])]));
    expect(outcome.exitCode).toBe(0);
    const floor = parseEvidenceFloor(JSON.parse(written ?? ''));
    expect(floor.version).toBe(3);
    expect(floor.scope).toBeUndefined();
    expect(floor.entries).toHaveLength(1);
  });

  it('still refuses when a screen has a measurement gap, whatever the old floor is', async () => {
    const v2 = { version: 2, entries: [{ screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: null, identityBasis: 'count', count: 2 }] };
    const gap = [{ ref: 'http://127.0.0.1:5173/clusters', state: 'not-covered' as const, reason: 'page rendered nothing' }];
    const { outcome, written } = await baseline(depsWith(v2, [scan([buttonInRow(A)], gap)]));
    expect(outcome.exitCode).toBe(3);
    expect(written).toBeNull();
  });
});
