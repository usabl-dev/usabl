/**
 * Cover for the second half of issue #152: usabl scanned a login-gated application with no
 * session, measured three blank documents, and minted `regression` from three generic axe rules
 * with `coverage.gaps: []`. Findings produced on a page the engine never saw are not weak
 * evidence, they are not evidence, so they must never reach the gate.
 */
import { describe, it, expect } from 'vitest';
import { run } from '../src/run.js';
import { runBaseline } from '../src/baseline/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { testConfig } from './helpers.js';
import type { Draft, ScreenScan, TranscriptStop } from '../src/contracts/index.js';

const config = testConfig({
  surfaces: [
    { id: 'overview', url: 'http://127.0.0.1:4200/overview', files: ['fixtures/app/src/OverviewPage.tsx'] },
    { id: 'jobs', url: 'http://127.0.0.1:4200/jobs', files: ['fixtures/app/src/JobsPage.tsx'] },
    { id: 'inventories', url: 'http://127.0.0.1:4200/inventories', files: ['fixtures/app/src/InventoriesPage.tsx'] },
  ],
});

const guardOk = { files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } };

const changedAll = [
  { code: 'M', path: 'fixtures/app/src/OverviewPage.tsx' },
  { code: 'M', path: 'fixtures/app/src/JobsPage.tsx' },
  { code: 'M', path: 'fixtures/app/src/InventoriesPage.tsx' },
];

// The path a live blank page actually reports for the document body. Verified against a running
// dev server whose backend was down: every one of fifty tab presses left focus here.
const BODY_PATH = 'html > body:nth-child(2)';

const bodyOnlyStops: TranscriptStop[] = [{ index: 0, elementPath: BODY_PATH, announcement: [] }];

const realStops = (path: string): TranscriptStop[] => [{ index: 0, elementPath: path, announcement: [] }];

// The three rules axe fires on an empty document. They carry no accessible name, so each keys on
// the structural basis and every screen produces the same key once the screen id is set aside.
const BLANK_PAGE_RULES = ['aria-required-children', 'landmark-one-main', 'page-has-heading-one'];

function draft(screenId: string, rule: string, overrides: Partial<Draft> = {}): Draft {
  return {
    rule,
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: 'html',
    elementName: null,
    role: null,
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'fail',
    ...overrides,
  };
}

function blankScreen(screenId: string): ScreenScan {
  const surface = config.surfaces.find((s) => s.id === screenId);
  return {
    screenId,
    url: surface?.url ?? '',
    stops: bodyOnlyStops,
    drafts: BLANK_PAGE_RULES.map((rule) => draft(screenId, rule)),
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
  };
}

const blankRun = {
  ...guardOk,
  changed: changedAll,
  scans: {
    overview: blankScreen('overview'),
    jobs: blankScreen('jobs'),
    inventories: blankScreen('inventories'),
  },
};

describe('unseen screens', () => {
  it('refuses the run when every affected screen is blank (issue #152)', async () => {
    const r = await run(makeFakeDeps(blankRun), config);

    // No accessibility verdict is honest when nothing was measured.
    expect(r.verdict).toBeNull();
    expect(r.accessibilityVerdict).toBeNull();
    expect(r.exitCode).toBe(4);
    expect(r.accessibilityExitCode).toBe(4);
    expect(r.summary).toContain('never saw the application');
    // Refusal is not idle. Idle means no UI-touching files changed, which is a legitimate state.
    expect(r.coverage.nothingToCheck).toBe(false);
    // The blank-page rules must not survive as findings, and no floor draft can be built from them.
    expect(r.findings).toEqual([]);
    expect(r.screens.flatMap((screen) => screen.drafts)).toEqual([]);
    // Every screen is disclosed, with a reason a human can act on.
    expect(r.coverage.gaps).toHaveLength(3);
    for (const gap of r.coverage.gaps) {
      expect(gap.reason).not.toBe('');
      expect(gap.reason).toContain('did not see');
    }
    expect(r.receipt).toBeNull();
  });

  it('drops drafts and records one gap for a body-only screen', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: changedAll,
      scans: {
        overview: blankScreen('overview'),
        // Two screens that were really walked, so the whole run is not refused.
        jobs: { screenId: 'jobs', url: config.surfaces[1]!.url, stops: realStops('button:nth-child(1)'), drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null },
        inventories: {
          screenId: 'inventories',
          url: config.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const r = await run(deps, config);

    expect(r.verdict).toBe('not_covered');
    expect(r.exitCode).toBe(3);
    const overview = r.screens.find((screen) => screen.screenId === 'overview');
    expect(overview?.drafts).toEqual([]);
    expect(overview?.gaps).toHaveLength(1);
    expect(overview?.gaps[0]?.state).toBe('not-covered');
    expect(overview?.gaps[0]?.reason).toContain('keyboard stop');
    expect(overview?.gaps[0]?.reason).toContain('did not see');
    // The screens usabl did walk keep their own outcome.
    expect(r.screens.filter((screen) => screen.gaps.length > 0)).toHaveLength(1);
  });

  it('keeps drafts on screens at distinct URLs that measured identically', async () => {
    // Two different URLs that carry the same barrier produce byte-identical finding identities. That
    // is real coverage, not a blank page: a templated route, a shared app shell, and two pages with
    // the same barrier all look like this. The removed duplicate-render heuristic wrongly dropped
    // both. With positive reachability, identical drafts across URLs are kept and still gate.
    const cloned = (screenId: string): ScreenScan => ({
      screenId,
      url: config.surfaces.find((s) => s.id === screenId)?.url ?? '',
      stops: realStops('button:nth-child(1)'),
      drafts: [
        draft(screenId, 'color-contrast', {
          elementPath: 'button',
          elementName: 'Save',
          role: 'button',
          evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
        }),
      ],
      gaps: [],
      applicability: [],
      reachedSelectorPresent: null,
    });
    const deps = makeFakeDeps({
      ...guardOk,
      changed: changedAll,
      scans: {
        overview: cloned('overview'),
        jobs: cloned('jobs'),
        inventories: {
          screenId: 'inventories',
          url: config.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const r = await run(deps, config);

    // Both screens are seen, their drafts survive, and a real barrier gates.
    expect(r.verdict).toBe('regression');
    for (const screenId of ['overview', 'jobs']) {
      const screen = r.screens.find((s) => s.screenId === screenId);
      expect(screen?.drafts).toHaveLength(1);
      expect(screen?.gaps).toEqual([]);
    }
    expect(r.screens.find((s) => s.screenId === 'inventories')?.gaps).toEqual([]);
    expect(r.coverage.gaps).toEqual([]);
  });

  it('still reports regression when a real barrier sits beside an unseen screen', async () => {
    // Precedence stays as it is: a genuine new barrier is the actionable answer even when another
    // screen was never seen. The gap is still disclosed on the screen it belongs to.
    const barrier = draft('jobs', 'color-contrast', {
      elementPath: 'button',
      elementName: 'Save',
      role: 'button',
      evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
    });
    const deps = makeFakeDeps({
      ...guardOk,
      changed: changedAll,
      scans: {
        overview: blankScreen('overview'),
        jobs: {
          screenId: 'jobs',
          url: config.surfaces[1]!.url,
          stops: realStops('button:nth-child(1)'),
          drafts: [barrier],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
        inventories: {
          screenId: 'inventories',
          url: config.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const r = await run(deps, config);

    expect(r.verdict).toBe('regression');
    expect(r.exitCode).toBe(1);
    expect(r.findings.filter((f) => f.status === 'new').map((f) => f.rule)).toEqual(['color-contrast']);
    expect(r.coverage.gaps).toHaveLength(1);
  });

  it('leaves a screen that was really walked alone', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: changedAll,
      scans: {
        overview: {
          screenId: 'overview',
          url: config.surfaces[0]!.url,
          stops: realStops('button:nth-child(1)'),
          drafts: [draft('overview', 'landmark-one-main')],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
        jobs: { screenId: 'jobs', url: config.surfaces[1]!.url, stops: realStops('a:nth-child(2)'), drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null },
        inventories: {
          screenId: 'inventories',
          url: config.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const r = await run(deps, config);

    expect(r.verdict).toBe('regression');
    expect(r.coverage.gaps).toEqual([]);
    expect(r.screens.find((s) => s.screenId === 'overview')?.drafts).toHaveLength(1);
  });

  it('does not call two clean screens duplicates of each other', async () => {
    // Two screens with no findings share an empty identity set. That is the absence of evidence,
    // not evidence they are the same page, so a clean run must still verify.
    const deps = makeFakeDeps({
      ...guardOk,
      changed: changedAll,
      scans: {
        overview: {
          screenId: 'overview',
          url: config.surfaces[0]!.url,
          stops: realStops('button:nth-child(1)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
        jobs: { screenId: 'jobs', url: config.surfaces[1]!.url, stops: realStops('a:nth-child(2)'), drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null },
        inventories: {
          screenId: 'inventories',
          url: config.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const r = await run(deps, config);

    expect(r.verdict).toBe('verified');
    expect(r.coverage.gaps).toEqual([]);
  });
});

describe('baseline against unseen screens', () => {
  const baselineConfig = config;
  const baselineFiles = {
    'usabl.config.json': '{}',
    'fixtures/app/src/OverviewPage.tsx': 'export {};\n',
    'fixtures/app/src/JobsPage.tsx': 'export {};\n',
    'fixtures/app/src/InventoriesPage.tsx': 'export {};\n',
  };

  it('writes no floor entry for an unseen screen', async () => {
    const written: Record<string, string> = {};
    const deps = makeFakeDeps({
      files: baselineFiles,
      headContents: baselineFiles,
      scans: {
        overview: blankScreen('overview'),
        jobs: {
          screenId: 'jobs',
          url: baselineConfig.surfaces[1]!.url,
          stops: realStops('button:nth-child(1)'),
          drafts: [draft('jobs', 'color-contrast', { elementPath: 'button', elementName: 'Save', role: 'button' })],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
        inventories: {
          screenId: 'inventories',
          url: baselineConfig.surfaces[2]!.url,
          stops: realStops('a:nth-child(3)'),
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });

    const outcome = await runBaseline(deps, baselineConfig, {
      writeFile: async (path, contents) => {
        written[path] = contents;
      },
    });

    expect(outcome.wrote).toBe(true);
    const floor = JSON.parse(written['.usabl-evidence.json'] ?? '{}');
    expect(floor.entries.map((entry: { screenId: string }) => entry.screenId)).toEqual(['jobs']);
    expect(outcome.message).toContain('incomplete');
  });

  it('writes no floor at all when every screen is unseen', async () => {
    const written: Record<string, string> = {};
    const deps = makeFakeDeps({
      files: baselineFiles,
      headContents: baselineFiles,
      scans: {
        overview: blankScreen('overview'),
        jobs: blankScreen('jobs'),
        inventories: blankScreen('inventories'),
      },
    });

    const outcome = await runBaseline(deps, baselineConfig, {
      writeFile: async (path, contents) => {
        written[path] = contents;
      },
    });

    expect(outcome.wrote).toBe(false);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.message).toContain('never saw the application');
    expect(written).toEqual({});
  });
});
