/**
 * `usabl baseline` scans twice and records only what both scans found.
 *
 * A floor accepts existing debt. A barrier one scan saw and the next did not is not stable debt: a
 * table showed a row that later went away, or a tooltip the scanner opened was still fading out. If
 * the floor recorded it, every later run without it would show headroom, and headroom is where a new
 * barrier can hide. So it is left off the floor and listed, by screen and rule, with what to do.
 * The list never names an element key, because a key can carry page text.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Draft, ScreenScan } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';
import { run } from '../../src/run.js';
import { testConfig } from '../helpers.js';

class MemoryBaselineFs {
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
    whatUserExperiences: 'A button action is announced without a usable name.', why: '', fix: '',
    evidence: {
      extra: { rowScope: { table: 'main>table', row, role: 'button', path: 'td:nth-child(4) > button:nth-child(1)' } },
    },
    confidence: 'fail',
  };
}

const contrast = (path: string): Draft => ({
  rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
  screenId: 'clusters', elementPath: path, elementName: null, role: null,
  whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
});

function scan(drafts: Draft[], gaps: ScreenScan['gaps'] = []): ScreenScan {
  return {
    screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', stops: [], drafts, gaps,
    applicability: [], reachedSelectorPresent: null,
  };
}

const POLICY = { 'usabl.config.json': '{}', 'fixtures/app/src/ClustersPage.tsx': 'export {};\n' };

/** Deps whose screen returns the next scan in the list on each call. */
function depsScanning(scans: ScreenScan[]): { deps: Deps; calls: () => number } {
  const base = makeFakeDeps({ files: POLICY, headContents: POLICY });
  let calls = 0;
  return {
    calls: () => calls,
    deps: {
      ...base,
      checkRunner: {
        scan: async () => {
          const next = scans[Math.min(calls, scans.length - 1)]!;
          calls += 1;
          return next;
        },
      },
    },
  };
}

const ROW_A = 'aaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccc';

describe('baseline stability pass', () => {
  it('scans twice and records only the barriers both scans found', async () => {
    const { deps, calls } = depsScanning([
      scan([buttonInRow(ROW_A), buttonInRow(ROW_B), buttonInRow(ROW_C)]),
      scan([buttonInRow(ROW_A), buttonInRow(ROW_B)]),
    ]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    expect(calls()).toBe(2);
    expect(outcome.exitCode).toBe(0);
    const floor = parseEvidenceFloor(JSON.parse(writer.read('.usabl-evidence.json') ?? ''));
    expect(floor.version).toBe(3);
    expect(floor.entries).toHaveLength(2);
    expect(floor.entries.every((entry) => entry.identityBasis === 'row' && entry.count === 1)).toBe(true);
    expect(outcome.entryCount).toBe(2);
  });

  it('lists what only one scan found by screen and rule, and says how to handle it', async () => {
    const { deps } = depsScanning([
      scan([buttonInRow(ROW_A), buttonInRow(ROW_B), buttonInRow(ROW_C)]),
      scan([buttonInRow(ROW_A)]),
    ]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    expect(outcome.message).toContain('intermittent');
    expect(outcome.message).toContain('screen clusters, rule pf-icon-button-name: 2');
    expect(outcome.message).toContain('blocks as new');
    expect(outcome.message).toContain('fixed data');
    // Never an element key: keys can carry page text.
    expect(outcome.message).not.toContain(ROW_B);
    expect(outcome.message).not.toContain(ROW_C);
    expect(outcome.message).not.toContain('row:');
  });

  it('records the smaller count when both scans found an identity but not equally often', async () => {
    const { deps } = depsScanning([
      scan([contrast('main > p:nth-child(1)'), contrast('main > p:nth-child(2)'), contrast('main > p:nth-child(3)')]),
      scan([contrast('main > p:nth-child(1)'), contrast('main > p:nth-child(2)')]),
    ]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    const floor = parseEvidenceFloor(JSON.parse(writer.read('.usabl-evidence.json') ?? ''));
    expect(floor.entries).toHaveLength(1);
    expect(floor.entries[0]!.count).toBe(2);
    expect(outcome.message).toContain('screen clusters, rule color-contrast: 1');
  });

  it('says both scans agreed when nothing came and went', async () => {
    const { deps } = depsScanning([scan([buttonInRow(ROW_A)])]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    expect(outcome.message).toContain('both scans found the same barriers');
    expect(outcome.message).not.toContain('intermittent');
  });

  it('refuses when the second scan has a gap the first did not, unless a partial floor is asked for', async () => {
    const gap = [{ ref: 'clusters', state: 'not-covered' as const, reason: 'page rendered nothing' }];
    const { deps } = depsScanning([scan([buttonInRow(ROW_A)]), scan([], gap)]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    expect(outcome.exitCode).toBe(3);
    expect(outcome.wrote).toBe(false);
    expect(writer.read('.usabl-evidence.json')).toBeNull();
  });

  it('floors no screen on a partial baseline that either scan saw with a gap', async () => {
    const gap = [{ ref: 'clusters', state: 'not-covered' as const, reason: 'page rendered nothing' }];
    const { deps } = depsScanning([scan([buttonInRow(ROW_A)]), scan([buttonInRow(ROW_A)], gap)]);
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer, { partial: true });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.message).toContain('nothing was cleanly scanned');
  });

  it('closes the proven false green: a floor of two, one fixed, one new in another row, blocks', async () => {
    // Baseline over a table with two broken rows.
    const { deps } = depsScanning([scan([buttonInRow(ROW_A), buttonInRow(ROW_B)])]);
    const writer = new MemoryBaselineFs();
    await runBaseline(deps, testConfig(), writer);
    const floorJson = writer.read('.usabl-evidence.json') ?? '';

    // Row A is fixed and a new broken row C arrives. The count of broken rows is still two.
    const files = { ...POLICY, '.usabl-evidence.json': floorJson };
    const later = makeFakeDeps({
      files,
      headContents: files,
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scan([buttonInRow(ROW_B), buttonInRow(ROW_C)]) },
    });
    const result = await run(later, testConfig());

    expect(result.verdict).toBe('regression');
    expect(result.receipt).toBeNull();
    expect(result.findings.filter((f) => f.status === 'new')).toHaveLength(1);
  });
});
