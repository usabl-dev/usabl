/**
 * A keyboard walk that was cut short is a coverage gap, never debt, so `usabl baseline` never
 * writes a floor entry for one. It does not carry an old one forward, and it does not record one a
 * provider still reports as a draft. The gate reads an old entry as a gap that names this command,
 * so this command must be the one that removes it.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { testConfig } from '../helpers.js';

class MemoryBaselineFs {
  contents: string | null = null;
  async writeFile(_path: string, contents: string): Promise<void> {
    this.contents = contents;
  }
}

const TRUNCATED_ENTRY = {
  screenId: 'clusters', layer: 'walk', rule: 'keyboard-walk-truncated', elementKey: null, identityBasis: 'count', count: 1,
};

function scanWith(drafts: Draft[]): ScreenScan {
  return { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', stops: [], drafts, gaps: [], applicability: [], reachedSelectorPresent: null };
}

function filesWith(floor: string | null): Record<string, string> {
  return {
    'usabl.config.json': '{}',
    'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
    ...(floor === null ? {} : { '.usabl-evidence.json': floor }),
  };
}

function truncatedDraft(): Draft {
  return {
    rule: 'keyboard-walk-truncated', layer: 'walk', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: '', elementName: null, role: null,
    whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'unverified',
  };
}

describe('usabl baseline and a keyboard walk that was cut short', () => {
  it('does not carry an old floor entry for one, even on a screen it cannot show rendered', async () => {
    const files = filesWith(JSON.stringify({ version: 3, entries: [TRUNCATED_ENTRY] }));
    const deps = makeFakeDeps({ files, headContents: files, scans: { clusters: scanWith([]) } });
    const writer = new MemoryBaselineFs();

    const outcome = await runBaseline(deps, testConfig(), writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(true);
    expect(JSON.parse(writer.contents ?? '{}')).toEqual({ version: 3, entries: [] });
    expect(outcome.message).not.toContain('kept');
  });

  it('does not record one that a provider still reports as a draft', async () => {
    const files = filesWith(null);
    const deps = makeFakeDeps({ files, headContents: files, scans: { clusters: scanWith([truncatedDraft()]) } });
    const writer = new MemoryBaselineFs();

    await runBaseline(deps, testConfig(), writer);

    expect(writer.contents ?? '').not.toContain('keyboard-walk-truncated');
  });
});
