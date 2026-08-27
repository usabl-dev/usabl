import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { run } from '../src/run.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const configBytes = JSON.stringify(config);
const emptyFloor = JSON.stringify({ version: 1, entries: [] });
const emptyRoutes = JSON.stringify({ routes: [] });

const cleanScan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [],
  gaps: [],
};

const failDraft: Draft = {
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
};

function ledger(over: { created?: string; expires?: string }): string {
  return JSON.stringify({
    version: 1,
    waivers: [
      {
        rule: 'color-contrast',
        surface: 'clusters',
        scope: '*',
        reason: 'tracked',
        owner: 'team',
        approvedBy: 'owner',
        created: over.created ?? '2026-01-01T00:00:00.000Z',
        expires: over.expires ?? '2026-12-31T00:00:00.000Z',
      },
    ],
  });
}

function matchingPolicy(waivers: string) {
  const files = {
    'usabl.config.json': configBytes,
    'usabl.routes.json': emptyRoutes,
    '.usabl-evidence.json': emptyFloor,
    '.usabl-waivers.json': waivers,
  };
  return { files, headContents: { ...files } };
}

describe('run rejects non-ISO-8601 UTC waiver dates', () => {
  it('does not treat expires "never" as a permanent waiver', async () => {
    const waivers = ledger({ expires: 'never' });
    const deps = makeFakeDeps({
      ...matchingPolicy(waivers),
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: { ...cleanScan, drafts: [failDraft] } },
    });

    const result = await run(deps, config);

    expect(result.verdict).not.toBe('verified');
    expect(result.receipt).toBeNull();
    expect(result.exitCode).toBe(4);
    expect(result.summary).toContain('ISO-8601 UTC');
    expect(result.summary).toContain('waiver expires');
  });

  it('rejects a garbage expires string', async () => {
    const waivers = ledger({ expires: 'tomorrow' });
    const deps = makeFakeDeps({
      ...matchingPolicy(waivers),
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.exitCode).toBe(4);
    expect(result.verdict).toBeNull();
    expect(result.summary).toContain('ISO-8601 UTC');
    expect(result.summary).toContain('waiver expires');
  });

  it('rejects a non-UTC expires offset', async () => {
    const waivers = ledger({ expires: '2026-12-31T00:00:00.000-05:00' });
    const deps = makeFakeDeps({
      ...matchingPolicy(waivers),
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.exitCode).toBe(4);
    expect(result.verdict).toBeNull();
    expect(result.summary).toContain('ISO-8601 UTC');
    expect(result.summary).toContain('waiver expires');
  });

  it('rejects a garbage created string', async () => {
    const waivers = ledger({ created: 'yesterday' });
    const deps = makeFakeDeps({
      ...matchingPolicy(waivers),
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.exitCode).toBe(4);
    expect(result.verdict).toBeNull();
    expect(result.summary).toContain('ISO-8601 UTC');
    expect(result.summary).toContain('waiver created');
  });

  it('still waives when created and expires are valid ISO-8601 UTC', async () => {
    const waivers = ledger({});
    const deps = makeFakeDeps({
      ...matchingPolicy(waivers),
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: { ...cleanScan, drafts: [failDraft] } },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.findings.find((f) => f.rule === 'color-contrast')?.status).toBe('waived');
  });
});
