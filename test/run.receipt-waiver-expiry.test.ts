import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { verifyReceipt } from '../src/evidence/receipt.js';
import { run } from '../src/run.js';

// Run level: the receipt run() mints binds the earliest expiry among the waivers the gate applied,
// and stops verifying at that moment. This is where the false green reached a pass before.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const NOW = '2026-03-01T00:00:00.000Z';
const FIRST_END = '2026-06-01T00:00:00.000Z';
const LATER_END = '2026-12-31T00:00:00.000Z';

const cleanScan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

function draft(rule: string, elementName: string): Draft {
  return {
    rule,
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: `button.${elementName}`,
    elementName,
    role: 'button',
    whatUserExperiences: `${elementName} is hard to use`,
    why: 'test barrier',
    fix: 'fix it',
    evidence: { name: { value: elementName, source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
  };
}

function waiver(rule: string, expires: string) {
  return {
    rule,
    surface: 'clusters',
    scope: '*',
    reason: 'tracked',
    owner: 'team',
    approvedBy: 'owner',
    created: '2026-01-01T00:00:00.000Z',
    expires,
  };
}

function depsFor(now: string, waivers: unknown[], drafts: Draft[]) {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    '.usabl-waivers.json': JSON.stringify({ version: 1, waivers }),
  };
  return makeFakeDeps({
    now,
    files,
    headContents: { ...files },
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: { ...cleanScan, drafts } },
  });
}

describe('run binds the end of the waivers it applied into the receipt', () => {
  it('binds the earliest expiry among the applied waivers and stops verifying then', async () => {
    const waivers = [
      waiver('color-contrast', LATER_END),
      waiver('button-name', FIRST_END),
      // Live, but nothing on this run matches it, so its end changes nothing.
      waiver('image-alt', '2026-04-01T00:00:00.000Z'),
    ];
    const drafts = [draft('color-contrast', 'Save'), draft('button-name', 'Close')];

    const result = await run(depsFor(NOW, waivers, drafts), config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt).not.toBeNull();
    expect(result.receipt!.activeWaivers).toBe(2);
    expect(result.receipt!.waiverExpiresAt).toBe(FIRST_END);

    const before = depsFor('2026-05-31T23:59:59.999Z', waivers, drafts);
    await expect(verifyReceipt(before, config, result.receipt!, result.receipt!.sourceTree)).resolves.toMatchObject({
      valid: true,
    });
    const after = depsFor(FIRST_END, waivers, drafts);
    const verification = await verifyReceipt(after, config, result.receipt!, result.receipt!.sourceTree);
    expect(verification.valid).toBe(false);
    expect(verification.failedFields).toEqual(['waiverExpiresAt']);

    // And the run at that moment no longer passes, which is why the receipt must not stand for it.
    const rerun = await run(after, config);
    expect(rerun.verdict).toBe('regression');
  });

  it('binds nothing when no waiver applied, so the receipt does not age', async () => {
    const result = await run(depsFor(NOW, [waiver('color-contrast', FIRST_END)], []), config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt!.activeWaivers).toBe(0);
    expect(result.receipt!.waiverExpiresAt).toBeNull();
    await expect(
      verifyReceipt(depsFor('2099-01-01T00:00:00.000Z', [], []), config, result.receipt!, result.receipt!.sourceTree),
    ).resolves.toMatchObject({ valid: true });
  });
});
