/**
 * The floor and waiver readers check the screen ids they read against the shared id grammar, the
 * same rule every other screen id answers to. A floor entry or waiver whose id the grammar refuses
 * can never match a screen, so it used to sit in the file matching nothing while reading as live
 * policy to anyone who opened it. On the run path such a file now ends the run as an unhandled
 * error that names the entry by position, the way any other malformed policy file does.
 */
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { parseWaiverLedger, run } from '../src/run.js';
import { InputRefusedError } from '../src/intake/input-refusal.js';
import { projectCli } from '../src/surfaces/cli.js';
import { parseResultJson } from '../src/surfaces/policy-enforce.js';

const waiver = {
  rule: 'button-name',
  surface: 'clusters',
  scope: '*',
  reason: 'tracked',
  owner: 'team',
  approvedBy: 'lead',
  created: '2026-01-01T00:00:00.000Z',
  expires: '2027-01-01T00:00:00.000Z',
};

describe('parseWaiverLedger surface ids', () => {
  it('refuses a surface the id grammar refuses, by position, without repeating it', () => {
    let refused: unknown;
    try {
      parseWaiverLedger({ version: 1, waivers: [waiver, { ...waiver, surface: 'leak-me​now' }] });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(InputRefusedError);
    expect((refused as InputRefusedError).field).toBe('waivers[1].surface');
    expect((refused as Error).message).toContain('U+200B');
    expect((refused as Error).message).not.toContain('leak-me');
  });

  it('accepts a ledger whose surfaces all pass the grammar', () => {
    expect(parseWaiverLedger({ version: 1, waivers: [waiver] }).waivers).toHaveLength(1);
  });
});

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

function depsWith(floor: unknown) {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify(floor),
  };
  return makeFakeDeps({
    files,
    headContents: { ...files },
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: {
      clusters: {
        screenId: 'clusters',
        url: config.surfaces[0]!.url,
        stops: [],
        drafts: [
          {
            rule: 'color-contrast',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: 'button',
            elementName: 'Save',
            role: 'button',
            whatUserExperiences: 'Save is hard to read',
            why: 'contrast too low',
            fix: 'Increase contrast',
            evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
            confidence: 'fail',
          },
        ],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
      },
    },
  });
}

const floorEntry = { screenId: 'clusters', layer: 'axe', rule: 'other', elementKey: null, identityBasis: 'count', count: 1 };

describe('run with a floor entry the id grammar refuses', () => {
  it('ends with exit 4 and names the entry by position, never the id', async () => {
    const result = await run(depsWith({ version: 2, entries: [floorEntry, { ...floorEntry, screenId: 'leak-me\u200bnow' }] }), config);
    expect(result.exitCode).toBe(4);
    expect(result.verdict).toBeNull();
    expect(result.receipt).toBeNull();
    expect(result.summary).toContain('entries[1].screenId');
    expect(result.summary).not.toContain('leak-me');
  });
});

describe('the Result the engine writes passes the Result check', () => {
  it('accepts the projected JSON of a regression run and of a crashed run', async () => {
    const regression = await run(depsWith({ version: 2, entries: [] }), config);
    expect(regression.verdict).toBe('regression');
    expect(() => parseResultJson(JSON.parse(projectCli(regression).json))).not.toThrow();

    const crashed = await run(depsWith({ version: 9, entries: [] }), config);
    expect(crashed.exitCode).toBe(4);
    expect(() => parseResultJson(JSON.parse(projectCli(crashed).json))).not.toThrow();
  });
});
