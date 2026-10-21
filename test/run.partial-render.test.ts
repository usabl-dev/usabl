/**
 * A floored barrier is reported paid down only when this run shows the part of the page that held
 * it rendered.
 *
 * The case this closes. A screen's header and navigation mount, and its content fails to mount.
 * The walk lands on a real link in the header, so the body-only floor is silent. No provider throws,
 * so no gap is raised. The content never rendered, so its floored barrier is absent from the
 * drafts, and the gate read that absence as a fix: the run was verified and claimed the barrier
 * paid down. A fixed barrier and content that never mounted leave the same absence, so the absence
 * alone proves neither.
 *
 * Driven through the real check runner, step runner, unseen pass, and gate, with a scripted page.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import type { AxNode, Deps, Page, Provider, SurfaceConfig, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';

// Reports nothing, so the only findings are the ones the gate makes from the floor.
const quietProvider: Provider = { id: 'quiet', layer: 'axe', capabilities: ['live'], run: async () => [] };

const SCREEN_URL = 'http://app.test/orders';

function configWith(reachedWhen: SurfaceConfig['reachedWhen']): UsablConfig {
  return {
    appBaseUrl: 'http://app.test',
    uiFileGlobs: ['fixtures/app/src/**'],
    discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
    surfaces: [
      {
        id: 'orders',
        url: SCREEN_URL,
        files: ['fixtures/app/src/OrdersPage.tsx'],
        ...(reachedWhen === undefined ? {} : { reachedWhen }),
      },
    ],
    guardedPaths: ['usabl.config.json'],
  };
}

// The three identity bases a floored barrier in the content can have. The unnamed icon button is
// counted, because an unnamed element cannot be keyed by name. The unnamed link in a table row is
// keyed by its path. The Delete button is keyed by its name.
const COUNT_ENTRY = {
  screenId: 'orders',
  layer: 'axe',
  rule: 'button-name',
  elementKey: null,
  identityBasis: 'count',
  count: 1,
};
const STRUCTURAL_ENTRY = {
  screenId: 'orders',
  layer: 'axe',
  rule: 'link-name',
  elementKey: 'orders|link-name|struct:link:#orders>tbody>tr>td>a',
  identityBasis: 'structural',
  count: 1,
};
const NAME_ENTRY = {
  screenId: 'orders',
  layer: 'axe',
  rule: 'target-size',
  elementKey: 'orders|target-size|name:delete',
  identityBasis: 'name',
  count: 1,
};

interface Stop {
  path: string;
  node: AxNode | null;
}

// What the walk lands on when only the chrome mounted: the header link, then back to it.
const CHROME_ONLY: Stop[] = [
  { path: 'html > body > header > nav > a#home', node: { name: 'Home', role: 'link', states: {} } },
];

// The finished screen with every floored barrier fixed: the row link now has a name, the Delete
// button is large enough, and the icon button has a name.
const FULLY_RENDERED: Stop[] = [
  { path: 'html > body > header > nav > a#home', node: { name: 'Home', role: 'link', states: {} } },
  {
    path: '#orders > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2) > a:nth-child(1)',
    node: { name: 'Order A-100', role: 'link', states: {} },
  },
  { path: '#orders-toolbar > button:nth-child(1)', node: { name: 'Delete', role: 'button', states: {} } },
  { path: '#orders-toolbar > button:nth-child(2)', node: { name: 'Refresh', role: 'button', states: {} } },
];

function pageFor(stops: Stop[], present: string[]): Page {
  let cursor = -1;
  const at = (): Stop => stops[Math.max(0, cursor) % stops.length]!;
  return makeFakePage({
    currentUrl: async () => SCREEN_URL,
    queryAll: async (selector: string) => (present.includes(selector) ? [{ selector }] : []),
    tab: async () => {
      cursor += 1;
    },
    activePath: async () => at().path,
    activeNode: async () => at().node,
  });
}

function depsFor(page: () => Page, config: UsablConfig, entries: unknown[]): Deps {
  const floor = JSON.stringify({ version: 2, entries });
  const files = { 'usabl.config.json': '{}', '.usabl-evidence.json': floor };
  const base = makeFakeDeps({
    files,
    headContents: files,
    writeTree: 'tree-partial-render',
    changed: [{ code: 'M', path: 'fixtures/app/src/OrdersPage.tsx' }],
  });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => page(), close: async () => {} },
      providers: [quietProvider],
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 6,
    }),
  };
}

describe('a screen whose chrome mounted and whose content did not', () => {
  const cases: Array<[string, unknown]> = [
    ['a counted barrier', COUNT_ENTRY],
    ['a barrier keyed by its path', STRUCTURAL_ENTRY],
    ['a barrier keyed by its name', NAME_ENTRY],
  ];
  for (const [name, entry] of cases) {
    it(`does not report ${name} in the missing content as paid down`, async () => {
      const config = configWith(undefined);
      const r = await run(depsFor(() => pageFor(CHROME_ONLY, ['header', 'nav']), config, [entry]), config);
      expect(r.findings.filter((f) => f.status === 'fixed')).toEqual([]);
      expect(r.paidDownCount).toBe(0);
      expect(r.verdict).toBe('not_covered');
      const gap = r.coverage.gaps.find((g) => g.ref === SCREEN_URL);
      expect(gap?.state).toBe('not-covered');
      expect(gap?.reason).toContain('orders');
    });
  }
});

describe('a fully rendered screen whose floored barriers were fixed', () => {
  it('pays down a counted barrier when the screen declares a signal and it held', async () => {
    const config = configWith('table#orders');
    const r = await run(
      depsFor(() => pageFor(FULLY_RENDERED, ['header', 'nav', 'table#orders']), config, [COUNT_ENTRY]),
      config,
    );
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
    expect(r.paidDownCount).toBe(1);
  });

  it('pays down a barrier keyed by its path when the walk landed on that element, with no signal', async () => {
    const config = configWith(undefined);
    const r = await run(depsFor(() => pageFor(FULLY_RENDERED, ['header', 'nav']), config, [STRUCTURAL_ENTRY]), config);
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
    expect(r.paidDownCount).toBe(1);
  });

  it('pays down a barrier keyed by its name when the walk landed on an element with that name, with no signal', async () => {
    const config = configWith(undefined);
    const r = await run(depsFor(() => pageFor(FULLY_RENDERED, ['header', 'nav']), config, [NAME_ENTRY]), config);
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
    expect(r.paidDownCount).toBe(1);
  });

  it('cannot pay down a counted barrier with no signal, because nothing places it on the page', async () => {
    // The cost of the rule, pinned so it is a decision and not an accident. A counted identity has
    // no element in it, so only a readiness signal that held can tell a fix from content that
    // never mounted. Without one the run is a gap until the operator declares a signal or prunes.
    const config = configWith(undefined);
    const r = await run(depsFor(() => pageFor(FULLY_RENDERED, ['header', 'nav']), config, [COUNT_ENTRY]), config);
    expect(r.paidDownCount).toBe(0);
    expect(r.verdict).toBe('not_covered');
    const gap = r.coverage.gaps.find((g) => g.ref === SCREEN_URL);
    expect(gap?.reason).toContain('reachedWhen');
    expect(gap?.reason).toContain('usabl floor prune');
  });
});
