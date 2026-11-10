import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Deps, Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { makeGitReader } from '../src/deps/git.js';
import { run } from '../src/run.js';

const execFileAsync = promisify(execFile);

// Run level: the run reads the tree identity before it plans and again after it scans. A tree that
// changed in between was not the tree the scan saw, so the run is not covered and mints no receipt.

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

// A working tree that someone edits while the check runs. The edit lands during the scan of the
// screen, the way an editor or a background agent writes a file while the browser is on the page.
function editedDuringScan(drafts: Draft[] = []): { deps: Deps; treeReads: () => number } {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
  };
  const base = makeFakeDeps({
    files,
    headContents: { ...files },
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: { ...cleanScan, drafts } },
  });
  let edited = false;
  let reads = 0;
  const deps: Deps = {
    ...base,
    git: {
      ...base.git,
      writeTree: async () => {
        reads += 1;
        return edited ? 'tree-after-edit' : 'tree-before-edit';
      },
    },
    checkRunner: {
      ...base.checkRunner,
      scan: async (target) => {
        const scan = await base.checkRunner.scan(target);
        edited = true;
        return scan;
      },
    },
  };
  return { deps, treeReads: () => reads };
}

// A tree that changes after the run's second read and before the receipt is minted: the edit lands
// when the run reads its clock for the gate, after everything the scan saw. A receipt that reads
// the tree at mint would bind the edited tree, which no scan saw.
function editedAfterTheCheck(): Deps {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
  };
  const base = makeFakeDeps({
    files,
    headContents: { ...files },
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: cleanScan },
  });
  let edited = false;
  return {
    ...base,
    clock: () => {
      edited = true;
      return base.clock();
    },
    git: {
      ...base.git,
      writeTree: async () => (edited ? 'tree-edited-later' : 'tree-scanned'),
    },
  };
}

describe('a tree that changed during the check', () => {
  it('is not covered, names the change, and mints no receipt', async () => {
    const { deps } = editedDuringScan();

    const result = await run(deps, config);

    expect(result.verdict).toBe('not_covered');
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === 'working tree');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('changed while usabl was checking');
    expect(gap?.reason).toContain('run usabl again');
  });

  it('never reads as verified, even when it also found an accessibility barrier', async () => {
    const { deps } = editedDuringScan([failDraft]);

    const result = await run(deps, config);

    expect(result.verdict).not.toBe('verified');
    expect(result.receipt).toBeNull();
    expect(result.coverage.gaps.some((g) => g.ref === 'working tree')).toBe(true);
  });
});

describe('a repository with no commits', () => {
  it('ends with no verdict and exit 4, and says to make a first commit', async () => {
    // A real empty repository: git has no HEAD, so the working tree cannot be read against it.
    const repo = await mkdtemp(join(tmpdir(), 'usabl-run-no-commits-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repo });
      const files = {
        'usabl.config.json': JSON.stringify(config),
        'usabl.routes.json': JSON.stringify({ routes: [] }),
      };
      const base = makeFakeDeps({ files, headContents: { ...files }, changed: [] });
      const deps: Deps = { ...base, git: { ...base.git, writeTree: makeGitReader({ cwd: repo }).writeTree } };

      const result = await run(deps, config);

      expect(result.verdict).toBeNull();
      expect(result.exitCode).toBe(4);
      expect(result.receipt).toBeNull();
      expect(result.summary).toMatch(/no commits yet.*make a first commit/is);
      expect(result.summary).not.toMatch(/fatal|Command failed|read-tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('a tree that did not change during the check', () => {
  it('still mints a receipt', async () => {
    const files = {
      'usabl.config.json': JSON.stringify(config),
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    };
    const deps = makeFakeDeps({
      files,
      headContents: { ...files },
      writeTree: 'tree-steady',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.sourceTree).toBe('tree-steady');
    expect(result.coverage.gaps).toEqual([]);
  });

  it('binds the tree the scan saw, not one read after the check', async () => {
    const result = await run(editedAfterTheCheck(), config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.sourceTree).toBe('tree-scanned');
  });
});
