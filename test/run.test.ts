import { describe, it, expect } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
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
  whatUserExperiences: '',
  why: '',
  fix: '',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};
const scanWith = (drafts: Draft[], gaps: ScreenScan['gaps'] = []): ScreenScan => ({
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts,
  gaps,
});
const guardOk = { files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } };

describe('run', () => {
  it('is idle (verdict null, exit 0) when no UI files changed', async () => {
    const deps = makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'README.md' }] });
    const r = await run(deps, config);
    expect(r.verdict).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.coverage.nothingToCheck).toBe(true);
  });

  it('verifies and mints a receipt when an affected surface is clean', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      writeTree: 'tree-1',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('verified');
    expect(r.receipt?.sourceTree).toBe('tree-1');
    expect(r.exitCode).toBe(0);
  });

  it('regresses (exit 1) and mints no receipt on a new failure', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('regression');
    expect(r.receipt).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  it('is not_covered (exit 3) when a UI file maps to no surface', async () => {
    const deps = makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'fixtures/app/src/Orphan.tsx' }], scans: {} });
    const r = await run(deps, config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.unresolvedFiles).toContain('fixtures/app/src/Orphan.tsx');
    expect(r.exitCode).toBe(3);
  });

  it('is not_covered (exit 3) when the scan returns coverage gaps', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: {
        clusters: scanWith([], [{ ref: config.surfaces[0]!.url, state: 'not-covered', reason: 'screen failed to open: timeout' }]),
      },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.gaps).toEqual([
      { ref: config.surfaces[0]!.url, state: 'not-covered', reason: 'screen failed to open: timeout' },
    ]);
    expect(r.exitCode).toBe(3);
  });

  it('is approval_required (exit 2) when a guarded path diverged', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"tampered":true}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [{ code: 'M', path: 'usabl.config.json' }],
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.dirtyGuardedPaths).toEqual(['usabl.config.json']);
    expect(r.exitCode).toBe(2);
    expect(r.accessibilityVerdict).toBeNull();
    expect(r.accessibilityExitCode).toBe(0);
    expect(r.coverage.nothingToCheck).toBe(true);
  });

  it('scans affected UI when policy diverged and keeps accessibility as regression', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"tampered":true}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [
        { code: 'M', path: 'usabl.config.json' },
        { code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' },
      ],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.exitCode).toBe(2);
    expect(r.receipt).toBeNull();
    expect(r.accessibilityVerdict).toBe('regression');
    expect(r.accessibilityExitCode).toBe(1);
    expect(r.findings.some((finding) => finding.rule === 'color-contrast')).toBe(true);
  });

  it('lists every dirty guarded path when config and evidence both changed', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"tampered":true}',
        '.usabl-evidence.json': '{"version":1,"entries":[]}',
      },
      headContents: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': '{"version":1,"entries":[{"screenId":"x","layer":"axe","rule":"r","elementKey":null,"identityBasis":"count","count":1}]}',
      },
      changed: [
        { code: 'M', path: 'usabl.config.json' },
        { code: 'M', path: '.usabl-evidence.json' },
      ],
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.dirtyGuardedPaths).toEqual(['.usabl-evidence.json', 'usabl.config.json']);
  });

  it('scans using trusted-ref config URLs when working-tree config diverged', async () => {
    const goodConfigJson = JSON.stringify({
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['fixtures/app/src/**'],
      discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
      surfaces: [
        { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
      ],
      guardedPaths: ['usabl.config.json'],
    });
    const evilConfig = {
      ...config,
      appBaseUrl: 'http://evil.test',
      surfaces: [{ id: 'clusters', url: 'http://evil.test/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
    };
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"appBaseUrl":"http://evil.test"}' },
      headContents: { 'usabl.config.json': goodConfigJson },
      refContents: { 'origin/main': { 'usabl.config.json': goodConfigJson } },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, evilConfig, { trustedRef: 'origin/main' });
    expect(r.verdict).toBe('approval_required');
    expect(r.screens[0]?.url).toBe('http://127.0.0.1:5173/clusters');
    expect(r.accessibilityVerdict).toBe('regression');
  });
});
