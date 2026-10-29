/**
 * Through run(): a table whose rows were keyed when the floor was written, and whose rows can no
 * longer be told apart today, is a coverage gap. The old shared key would collapse the rows again,
 * where a barrier fixed in one row and a new one in another leave the count unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Draft, Provider, RowContextRead, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';
import { computeIdentity } from '../src/primitives/identity.js';
import { attachRowScopeToDrafts } from '../src/providers/row-scope.js';
import { run } from '../src/run.js';

const URL = 'http://app.test/jobs';
const config: UsablConfig = {
  appBaseUrl: 'http://app.test',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'jobs', url: URL, files: ['src/JobsPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const button = (path: string): Draft => ({
  rule: 'button-name', layer: 'axe', severity: 'critical', evidenceClass: 'deterministic',
  screenId: 'jobs', elementPath: path, elementName: null, role: null,
  whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
});

const keyed = (key: string): RowContextRead => ({
  kind: 'keyed', table: '[["unnamed",""]]', source: 'attr:data-row-key', key, role: 'button', path: 'td:nth-child(2) > button:nth-child(1)',
  otherKeys: [], otherTables: [],
});

function depsWith(floorJson: string, answers: Record<string, RowContextRead>): Deps {
  const files = { 'usabl.config.json': '{}', 'src/JobsPage.tsx': 'export {};\n', '.usabl-evidence.json': floorJson };
  const provider: Provider = { id: 'buttons', layer: 'axe', capabilities: ['live'], run: async () => [button('#a'), button('#b')] };
  const base = makeFakeDeps({ files, headContents: files, changed: [{ code: 'M', path: 'src/JobsPage.tsx' }] });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: {
        open: async () =>
          makeFakePage({
            currentUrl: async () => URL,
            activePath: async () => 'html > body > main > button',
            rowContext: async (selector: string) => answers[selector] ?? { kind: 'none' },
          }),
        close: async () => {},
      },
      providers: [provider],
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 2,
    }),
  };
}

async function floorOfKeyedRows(): Promise<string> {
  const page = makeFakePage({ rowContext: async (s: string) => (s === '#a' ? keyed('r1') : keyed('r2')) });
  const { drafts } = await attachRowScopeToDrafts(page, { id: 'jobs', url: URL }, [button('#a'), button('#b')]);
  const entries = drafts.map((d) => {
    const id = computeIdentity(d);
    return { screenId: 'jobs', layer: 'axe', rule: 'button-name', elementKey: id.elementKey, identityBasis: id.identityBasis, count: 1 };
  });
  return JSON.stringify({ version: 3, entries });
}

describe('rows that could be told apart when the floor was written and cannot be today', () => {
  it('is verified while the rows keep unique keys', async () => {
    const floor = await floorOfKeyedRows();
    const result = await run(depsWith(floor, { '#a': keyed('r1'), '#b': keyed('r2') }), config);
    expect(result.verdict).toBe('verified');
  });

  it('is not covered, never verified, once two rows share a key', async () => {
    const floor = await floorOfKeyedRows();
    const duplicate: RowContextRead = { kind: 'ambiguous', reason: 'row-key-duplicate' };
    const result = await run(depsWith(floor, { '#a': duplicate, '#b': duplicate }), config);
    expect(result.verdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
    expect(result.coverage.gaps.some((g) => g.reason.includes('screen jobs, rule button-name: 2'))).toBe(true);
    // The rows are not claimed fixed on a screen whose rows could not be told apart.
    expect(result.paidDownCount).toBe(0);
  });
});
