/**
 * Prune keys the run the way the floor it prunes was written: per row for a version 3 floor, and
 * collapsed across rows for a version 2 floor. Mixing the two would remove every recorded entry
 * as gone, or keep none.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runFloorPrune } from '../../src/floor/prune.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import { testConfig } from '../helpers.js';

class MemoryFloorFs {
  private readonly store = new Map<string, string>();
  async writeFile(path: string, contents: string): Promise<void> {
    this.store.set(path, contents);
  }
  read(path: string): string | null {
    return this.store.get(path) ?? null;
  }
}

function buttonInRow(row: string): Draft {
  return {
    rule: 'pf-icon-button-name', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'main > table > tbody > tr > td > button', elementName: null, role: 'button',
    whatUserExperiences: '', why: '', fix: '',
    evidence: {
      extra: { rowScope: { table: 'main>table', row, role: 'button', path: 'td:nth-child(4) > button:nth-child(1)' } },
    },
    confidence: 'fail',
  };
}

function scan(drafts: Draft[]): ScreenScan {
  return {
    screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', stops: [], drafts, gaps: [],
    applicability: [], reachedSelectorPresent: null,
  };
}

function depsWith(floorJson: string, drafts: Draft[]) {
  const files = {
    'usabl.config.json': '{}',
    'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
    '.usabl-evidence.json': floorJson,
  };
  return makeFakeDeps({ files, headContents: files, scans: { clusters: scan(drafts) } });
}

const ROW_A = 'aaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbb';

describe('floor prune with row keys', () => {
  it('removes the entry for a row that is gone and keeps the row still present, on a version 3 floor', async () => {
    const entry = (row: string) => {
      const identity = computeIdentity(buttonInRow(row));
      return { screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: identity.elementKey, identityBasis: identity.identityBasis, count: 1 };
    };
    const floor: EvidenceFloor = { version: 3, entries: [entry(ROW_A), entry(ROW_B)] };
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(depsWith(JSON.stringify(floor), [buttonInRow(ROW_B)]), testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    const written = JSON.parse(writer.read('.usabl-evidence.json') ?? '') as EvidenceFloor;
    expect(written.version).toBe(3);
    expect(written.entries.map((e) => e.elementKey)).toEqual([entry(ROW_B).elementKey]);
  });

  it('lowers the collapsed count on a version 2 floor and keeps version 2', async () => {
    const legacy = computeIdentity(buttonInRow(ROW_A), 'legacy');
    const floor: EvidenceFloor = {
      version: 2,
      entries: [{ screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: legacy.elementKey, identityBasis: legacy.identityBasis, count: 3 }],
    };
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(depsWith(JSON.stringify(floor), [buttonInRow(ROW_A), buttonInRow(ROW_B)]), testConfig(), writer);

    expect(outcome.prunedCount).toBe(0);
    expect(outcome.loweredCount).toBe(1);
    const written = JSON.parse(writer.read('.usabl-evidence.json') ?? '') as EvidenceFloor;
    expect(written.version).toBe(2);
    expect(written.entries).toEqual([{ ...floor.entries[0], count: 2 }]);
  });

  it('changes only the entries of a version 3 floor, keeping its scope and a field it does not know', async () => {
    const entry = (row: string) => {
      const identity = computeIdentity(buttonInRow(row));
      return { screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: identity.elementKey, identityBasis: identity.identityBasis, count: 1 };
    };
    const document = { version: 3, scope: 'partial', observedAt: 'kept as written', entries: [entry(ROW_A), entry(ROW_B)] };
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(depsWith(JSON.stringify(document), [buttonInRow(ROW_B)]), testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    const written = JSON.parse(writer.read('.usabl-evidence.json') ?? '') as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['version', 'scope', 'observedAt', 'entries']);
    expect(written).toEqual({ ...document, entries: [entry(ROW_B)] });
  });

  it('still counts a version 2 floor the old way when it carries a field it does not know', async () => {
    const legacy = computeIdentity(buttonInRow(ROW_A), 'legacy');
    const document = {
      version: 2,
      observedAt: 'kept as written',
      entries: [{ screenId: 'clusters', layer: 'pf', rule: 'pf-icon-button-name', elementKey: legacy.elementKey, identityBasis: legacy.identityBasis, count: 3 }],
    };
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(depsWith(JSON.stringify(document), [buttonInRow(ROW_A), buttonInRow(ROW_B)]), testConfig(), writer);

    expect(outcome.loweredCount).toBe(1);
    const written = JSON.parse(writer.read('.usabl-evidence.json') ?? '') as Record<string, unknown>;
    expect(written).toEqual({ ...document, entries: [{ ...document.entries[0], count: 2 }] });
  });
});

