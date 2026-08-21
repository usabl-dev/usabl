import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { run } from '../../src/run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { canonicalize } from '../../src/primitives/canonical.js';
import type { Draft, ScreenScan, UsablConfig } from '../../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173', uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};
const fail: Draft = {
  rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
  screenId: 'clusters', elementPath: 'button', elementName: 'Save', role: 'button',
  whatUserExperiences: 'Low contrast', why: 'ratio 2:1', fix: 'Raise to 4.5:1',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } }, confidence: 'fail',
};
const scan = (drafts: Draft[]): ScreenScan => ({ screenId: 'clusters', url: config.surfaces[0]!.url, stops: [], drafts, gaps: [] });
const guardOk = { files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' }, writeTree: 'tree-fixed', now: '2026-08-19T00:00:00.000Z' };

const scenarios: Record<string, () => ReturnType<typeof makeFakeDeps>> = {
  idle: () => makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'README.md' }] }),
  verified: () => makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }], scans: { clusters: scan([]) } }),
  regression: () => makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }], scans: { clusters: scan([fail]) } }),
  not_covered: () => makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'fixtures/app/src/Orphan.tsx' }] }),
  approval_required: () => makeFakeDeps({ files: { 'usabl.config.json': '{"x":1}' }, headContents: { 'usabl.config.json': '{}' }, writeTree: 'tree-fixed', now: guardOk.now, changed: [{ code: 'M', path: 'usabl.config.json' }] }),
};

const UPDATE = process.env.UPDATE_GOLDEN === '1';

describe('golden oracle', () => {
  for (const [name, mkDeps] of Object.entries(scenarios)) {
    it(`canonical Result is stable for ${name}`, async () => {
      const result = await run(mkDeps(), config);
      const canonical = canonicalize(result);
      const path = new URL(`../../fixtures/golden/${name}.json`, import.meta.url);
      if (UPDATE) { await writeFile(path, canonical + '\n', 'utf8'); return; }
      const expected = (await readFile(path, 'utf8')).trim();
      expect(canonical).toBe(expected);
    });
  }
});
