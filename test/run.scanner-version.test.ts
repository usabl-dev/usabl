import { describe, expect, it } from 'vitest';
import type { ScannerVersions, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { mintReceipt, verifyReceipt } from '../src/evidence/receipt.js';
import { run } from '../src/run.js';

// Run level: a scanner version usabl cannot read used to mint and verify as "unknown", so a swapped
// scanner could reuse an old result. Now the run is not covered, names the fix, and mints nothing.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const cleanScan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

const READABLE: ScannerVersions = { axeCore: '4.13.0', playwright: '1.62.1', chromium: '151.0.7922.34' };

function depsWith(scannerVersions: ScannerVersions, changed = true) {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
  };
  return makeFakeDeps({
    files,
    headContents: { ...files },
    scannerVersions,
    changed: changed ? [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }] : [],
    scans: { clusters: cleanScan },
  });
}

describe('a scanner version usabl cannot read', () => {
  it('makes the run not covered, with no receipt, and the gap names the Chromium fix', async () => {
    const result = await run(depsWith({ ...READABLE, chromium: 'unknown' }), config);

    expect(result.verdict).toBe('not_covered');
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === 'scanner versions');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('could not read the version of Chromium');
    expect(gap?.reason).toContain('npx playwright install chromium');
    expect(gap?.reason).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(gap?.reason).toContain('usabl doctor');
  });

  it('names each package it could not read and the fix for packages', async () => {
    const result = await run(depsWith({ axeCore: 'unknown', playwright: '', chromium: READABLE.chromium }), config);

    expect(result.verdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === 'scanner versions');
    expect(gap?.reason).toContain('axe-core and Playwright');
    expect(gap?.reason).toContain('npm ci');
    expect(gap?.reason).not.toContain('npx playwright install chromium');
  });

  it('leaves an idle run idle', async () => {
    const result = await run(depsWith({ ...READABLE, chromium: 'unknown' }, false), config);

    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.coverage.gaps).toEqual([]);
  });

  it('still verifies an ordinary page when every version reads', async () => {
    const result = await run(depsWith(READABLE), config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.scannerVersions).toEqual(READABLE);
    expect(result.coverage.gaps).toEqual([]);
  });
});

describe('a receipt and an unreadable scanner version', () => {
  const mintArgs = {
    surfaces: ['cli'],
    checked: ['clusters'],
    notCovered: [],
    applicability: [],
    findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
    activeWaivers: 0,
  };

  it('is never minted', async () => {
    await expect(mintReceipt(depsWith({ ...READABLE, chromium: 'unknown' }), config, mintArgs)).rejects.toThrow(
      /Chromium/,
    );
  });

  it('does not verify when the stored receipt holds one, even against the same unreadable value', async () => {
    const minted = await mintReceipt(depsWith(READABLE), config, mintArgs);
    const stored = { ...minted, scannerVersions: { ...READABLE, chromium: 'unknown' } };

    const verification = await verifyReceipt(depsWith({ ...READABLE, chromium: 'unknown' }), config, stored, minted.sourceTree);

    expect(verification.valid).toBe(false);
    expect(verification.failedFields).toEqual(['scannerVersions']);
  });

  it('does not verify when the current version cannot be read', async () => {
    const minted = await mintReceipt(depsWith(READABLE), config, mintArgs);
    const verification = await verifyReceipt(
      depsWith({ ...READABLE, axeCore: 'unknown' }),
      config,
      minted,
      minted.sourceTree,
    );
    expect(verification.valid).toBe(false);
    expect(verification.failedFields).toEqual(['scannerVersions']);
  });
});
