/**
 * The Deque provider against a fake SDK. Deque's package is on a private registry, so the fake
 * returns real axe-core results recorded from open-source axe on fixtures/engines/deque-page.html,
 * plus Deque-only rules injected beside them. That proves the open-source duplicates are dropped and
 * Deque's own rules map through the axe mapping. The real-browser version of this test lives in
 * deque.real.integration.test.ts.
 *
 * Deque findings are preview in this release: shown, never gating, until a live run on a licensed
 * SDK proves which rules are stable.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Page, ProviderContext } from '../../../src/contracts/index.js';
import { makeFakePage } from '../../../src/deps/fakes.js';
import { runProviders } from '../../../src/providers/index.js';
import { DOCS_AXE_TAGS, mapAxeRunResult } from '../../../src/providers/axe/index.js';
import { normalizeAxeResults } from '../../../src/providers/axe/raw.js';
import {
  DEQUE_TRACK_USAGE_ENV,
  dequeCapabilities,
  makeDequeProvider,
  mapDequeResults,
  withoutOpenSourceAxeRules,
  type DequeProviderOptions,
} from '../../../src/providers/engines/deque.js';
import { openSourceAxeRuleIds, registerPlaywrightPage } from '../../../src/providers/engines/shared.js';
import { applicabilityOf, draftsOf, gapsOf, testConfig } from '../../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

async function recordedAxeResults(): Promise<Record<string, unknown>> {
  const path = fileURLToPath(new URL('../../../fixtures/engines/axe-results.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

// Deque-only rules: one failing on one element and one passing on two.
const EXTRA_VIOLATION = {
  id: 'deque-extra-rule',
  impact: 'serious',
  description: 'Deque extra rule description',
  nodes: [{ target: ['main > a'], html: '<a href="/settings">Settings</a>', failureSummary: 'Fix the link.' }],
};
const EXTRA_PASS = { id: 'deque-extra-pass', nodes: [{ target: ['h1'] }, { target: ['main'] }] };

async function dequeResults(): Promise<Record<string, unknown>> {
  const axe = await recordedAxeResults();
  return {
    ...axe,
    violations: [...(axe['violations'] as unknown[]), EXTRA_VIOLATION],
    passes: [...(axe['passes'] as unknown[]), EXTRA_PASS],
  };
}

function livePage(): Page {
  const page = makeFakePage();
  registerPlaywrightPage(page, { fake: 'playwright page' });
  return page;
}

function ctxFor(page: Page, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return { page, screen: SCREEN, config: testConfig(), ...overrides };
}

interface Recorded {
  constructed: unknown[];
  calls: string[];
  tags: unknown[];
}

function newRecorded(): Recorded {
  return { constructed: [], calls: [], tags: [] };
}

function fakeDequeModule(
  results: unknown,
  recorded: Recorded,
  shape: { tracking?: boolean; tags?: boolean; analyze?: () => Promise<unknown> } = {},
) {
  class Builder {
    constructor(options: unknown) {
      recorded.constructed.push(options);
    }
    async analyze() {
      recorded.calls.push('analyze');
      return shape.analyze === undefined ? results : shape.analyze();
    }
  }
  if (shape.tracking !== false) {
    Object.assign(Builder.prototype, {
      enableTracking(state: boolean) {
        recorded.calls.push(`enableTracking(${String(state)})`);
        return this;
      },
    });
  }
  if (shape.tags !== false) {
    Object.assign(Builder.prototype, {
      withTags(tags: unknown) {
        recorded.calls.push('withTags');
        recorded.tags.push(tags);
        return this;
      },
    });
  }
  return async () => ({ AxeDevToolsBuilder: Builder });
}

// The environment a run must have for Deque, with usage tracking left off.
const TRACKING_OFF = { AXE_TRACK_USAGE: 'false' };

// Every test names its own loader and environment, and nothing on disk is ever consulted.
function provider(config: Parameters<typeof makeDequeProvider>[0], options: DequeProviderOptions) {
  return makeDequeProvider(config, {
    env: TRACKING_OFF,
    fileExists: async () => false,
    probe: async () => ({ state: 'installed', version: '4.11.2', missingDependencies: [] }),
    ...options,
  });
}

describe('mapDequeResults on recorded axe results', () => {
  it('drops every open-source axe rule and keeps Deque rules as preview drafts and applicability', async () => {
    const axeIds = await openSourceAxeRuleIds();
    const output = mapDequeResults(await dequeResults(), SCREEN.id, axeIds);

    // The recorded page fails button-name and image-alt in open-source axe. Neither survives.
    expect(draftsOf(output).map((draft) => draft.rule)).toEqual(['deque:deque-extra-rule']);
    expect(draftsOf(output)[0]).toMatchObject({
      layer: 'deque',
      evidenceClass: 'preview',
      confidence: 'fail',
      severity: 'serious',
      elementPath: 'main > a',
      screenId: SCREEN.id,
      whatUserExperiences: 'Deque extra rule description',
      why: 'Fix the link.',
    });
    expect(applicabilityOf(output)).toEqual([
      { screenId: SCREEN.id, layer: 'deque', rule: 'deque:deque-extra-rule', outcome: 'failed', elementCount: 1 },
      { screenId: SCREEN.id, layer: 'deque', rule: 'deque:deque-extra-pass', outcome: 'passed', elementCount: 2 },
    ]);
  });

  it('maps the recorded fixture plus one Deque rule exactly as the plain axe mapping does', async () => {
    const axeIds = await openSourceAxeRuleIds();
    const raw = await dequeResults();
    const output = mapDequeResults(raw, SCREEN.id, axeIds);
    const plain = mapAxeRunResult(withoutOpenSourceAxeRules(normalizeAxeResults(raw), axeIds), SCREEN.id, {
      layer: 'deque',
      rulePrefix: 'deque:',
      evidenceClass: 'preview',
    });
    expect(output).toEqual({ ...plain, gaps: [], notes: [] });
  });

  it('discloses every Deque violation it cannot read, by rule id, as a note while findings are preview', async () => {
    const axeIds = await openSourceAxeRuleIds();
    const axe = await recordedAxeResults();
    const noDescription = { id: 'deque-no-description', impact: 'serious', nodes: [{ target: ['#a'] }] };
    const badNodes = { id: 'deque-bad-nodes', impact: 'serious', description: 'Bad nodes', nodes: 'x' };
    const noId = { impact: 'serious', description: 'No id', nodes: [{ target: ['#b'] }] };
    const raw = { ...axe, violations: [...(axe['violations'] as unknown[]), EXTRA_VIOLATION, noDescription, badNodes, noId] };

    const output = mapDequeResults(raw, SCREEN.id, axeIds);

    expect(draftsOf(output).map((draft) => draft.rule)).toEqual(['deque:deque-extra-rule']);
    // A preview finding could never have moved the verdict, so losing one is a disclosure, not a gap.
    expect(gapsOf(output)).toEqual([]);
    const reasons = (output.notes ?? []).map((note) => note.reason);
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain('deque-no-description');
    expect(reasons[0]).toContain('could not be read');
    expect(reasons[1]).toContain('deque-bad-nodes');
    expect(reasons[1]).toContain('could not be read');
    expect(reasons[2]).toContain('unknown rule');
    expect((output.notes ?? []).every((note) => note.ref === 'provider:deque')).toBe(true);
  });

  it('makes the same losses coverage gaps when the findings would gate', async () => {
    const raw = {
      violations: [{ id: 'deque-bad-nodes', impact: 'serious', description: 'Bad nodes', nodes: 'x' }],
      incomplete: [],
      passes: [],
      inapplicable: [],
    };
    const output = mapDequeResults(raw, SCREEN.id, new Set(), 'deterministic');
    expect(output.notes).toEqual([]);
    expect(gapsOf(output)).toHaveLength(1);
    expect(gapsOf(output)[0]).toMatchObject({ ref: 'provider:deque', state: 'not-covered' });
    expect(gapsOf(output)[0]?.reason).toContain('deque-bad-nodes');
  });

  it('discloses a lost entry in any bucket, matched by id even when the id repeats', async () => {
    const raw = {
      violations: [],
      incomplete: [{ id: 'deque-twice', description: 'ok', nodes: [] }, { id: 'deque-twice', nodes: [] }],
      passes: [{ nodes: [] }],
      inapplicable: [],
    };
    const output = mapDequeResults(raw, SCREEN.id, new Set());
    const reasons = (output.notes ?? []).map((note) => note.reason);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('incomplete');
    expect(reasons[0]).toContain('deque-twice');
    expect(reasons[1]).toContain('passes');
    expect(reasons[1]).toContain('unknown rule');
  });

  it('reads a result with every bucket empty as a run that checked nothing, which is a gap', () => {
    const output = mapDequeResults(
      { violations: [], incomplete: [], passes: [], inapplicable: [] },
      SCREEN.id,
      new Set(['image-alt']),
    );
    expect(draftsOf(output)).toEqual([]);
    expect(applicabilityOf(output)).toEqual([]);
    expect(gapsOf(output)).toHaveLength(1);
    expect(gapsOf(output)[0]?.reason).toContain('Deque ran no rules on this screen, so it checked nothing');
  });

  it('proves the recorded fixture really holds open-source axe findings', async () => {
    const axe = await recordedAxeResults();
    const ids = (axe['violations'] as Array<{ id: string }>).map((issue) => issue.id);
    expect(ids).toEqual(expect.arrayContaining(['button-name', 'image-alt']));
    expect((axe['passes'] as unknown[]).length).toBeGreaterThan(0);
    expect((axe['inapplicable'] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('makeDequeProvider', () => {
  it('declares live only, and network only when usage tracking is opted in', () => {
    expect(dequeCapabilities({ enabled: true })).toEqual(['live']);
    expect(dequeCapabilities({ enabled: true, trackUsage: false })).toEqual(['live']);
    expect(dequeCapabilities({ enabled: true, trackUsage: true })).toEqual(['live', 'network']);
    expect(makeDequeProvider({ enabled: true }).layer).toBe('deque');
  });

  it('runs the builder on the Playwright page with the configured ruleset', async () => {
    const recorded = newRecorded();
    const output = await provider(
      { enabled: true, rulesetId: 'wcag2.2' },
      { load: fakeDequeModule(await dequeResults(), recorded) },
    ).run(ctxFor(livePage()));

    expect(recorded.constructed).toEqual([{ page: { fake: 'playwright page' }, rulesetId: 'wcag2.2' }]);
    expect(draftsOf(output).map((draft) => [draft.rule, draft.evidenceClass])).toEqual([
      ['deque:deque-extra-rule', 'preview'],
    ]);
  });

  it('turns usage tracking off through the builder before analyzing, and never writes the environment', async () => {
    const recorded = newRecorded();
    const frozen = Object.freeze({ ...TRACKING_OFF });
    await provider({ enabled: true }, { load: fakeDequeModule(await dequeResults(), recorded), env: frozen }).run(
      ctxFor(livePage()),
    );

    expect(recorded.calls).toEqual(['enableTracking(false)', 'analyze']);
    expect(frozen[DEQUE_TRACK_USAGE_ENV]).toBe('false');
  });

  it('runs when the environment already turns tracking off', async () => {
    const recorded = newRecorded();
    const output = await provider(
      { enabled: true },
      { load: fakeDequeModule(await dequeResults(), recorded, { tracking: false }), env: { AXE_TRACK_USAGE: 'false' } },
    ).run(ctxFor(livePage()));
    expect(draftsOf(output)).toHaveLength(1);
  });

  it('leaves tracking alone when the operator opts in', async () => {
    const recorded = newRecorded();
    await provider(
      { enabled: true, trackUsage: true },
      { load: fakeDequeModule(await dequeResults(), recorded), env: { AXE_TRACK_USAGE: 'true' } },
    ).run(ctxFor(livePage()));
    expect(recorded.calls).toEqual(['analyze']);
  });

  it('limits Deque to the docs WCAG tags on a docs screen, as axe is', async () => {
    const recorded = newRecorded();
    await provider({ enabled: true }, { load: fakeDequeModule(await dequeResults(), recorded) }).run(
      ctxFor(livePage(), { profile: 'docs' }),
    );
    expect(recorded.tags).toEqual([[...DOCS_AXE_TAGS]]);
    expect(recorded.calls).toEqual(['enableTracking(false)', 'withTags', 'analyze']);
  });

  it('passes no tags on an app screen', async () => {
    const recorded = newRecorded();
    await provider({ enabled: true }, { load: fakeDequeModule(await dequeResults(), recorded) }).run(
      ctxFor(livePage(), { profile: 'app' }),
    );
    expect(recorded.tags).toEqual([]);
  });

  it('accepts the builder from a CommonJS default export', async () => {
    const load = fakeDequeModule(await dequeResults(), newRecorded());
    const output = await provider({ enabled: true }, { load: async () => ({ default: await load() }) }).run(
      ctxFor(livePage()),
    );
    expect(draftsOf(output)).toHaveLength(1);
  });
});

describe('Deque failures become coverage gaps with a fix', () => {
  async function gapsFor(p: ReturnType<typeof makeDequeProvider>, ctx: ProviderContext = ctxFor(livePage())) {
    return (await runProviders([p], ctx, ['live'])).gaps;
  }

  it('says the package is not installed and how to get out', async () => {
    const notFound = Object.assign(new Error("Cannot find package '@axe-devtools/playwright'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const p = provider(
      { enabled: true },
      { load: async () => Promise.reject(notFound), probe: async () => ({ state: 'not-installed' }) },
    );

    expect(await gapsFor(p)).toEqual([
      {
        ref: 'provider:deque',
        state: 'not-covered',
        reason:
          "provider deque failed: Deque axe DevTools is turned on in usabl.config.json but @axe-devtools/playwright is not installed. Install it from Deque's registry (axe DevTools for Web Enterprise), or set engines.deque.enabled to false.",
      },
    ]);
  });

  it('reports the real dynamic import of the absent package as not installed', async () => {
    // No loader and no probe injected: this is the shipped import and the shipped lookup of the
    // vendor package name, which is not installed in this repository and never will be.
    const p = makeDequeProvider({ enabled: true }, { env: TRACKING_OFF, fileExists: async () => false });
    const [gap] = await gapsFor(p);
    expect(gap?.reason).toContain('@axe-devtools/playwright is not installed');
  });

  it('names a missing dependency of the package apart from not installed', async () => {
    const missingDep = Object.assign(new Error("Cannot find package 'axe-core-devtools' imported from /x/index.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const p = provider({ enabled: true }, { load: async () => Promise.reject(missingDep) });
    const [gap] = await gapsFor(p);
    expect(gap?.reason).toContain(
      '@axe-devtools/playwright 4.11.2 is installed but could not load, because axe-core-devtools, a package it needs, is not installed',
    );
  });

  it('says a package that is present but throws on import failed to load', async () => {
    const p = provider({ enabled: true }, { load: async () => Promise.reject(new Error('bad build')) });
    const [gap] = await gapsFor(p);
    expect(gap?.reason).toContain('@axe-devtools/playwright 4.11.2 is installed but failed to load: bad build');
    expect(gap?.reason).toContain('set engines.deque.enabled to false');
  });

  it('refuses a module without the builder export', async () => {
    const [gap] = await gapsFor(provider({ enabled: true }, { load: async () => ({}) }));
    expect(gap?.reason).toContain('does not export AxeDevToolsBuilder');
  });

  it('refuses a page with no Playwright page behind it', async () => {
    const [gap] = await gapsFor(provider({ enabled: true }, { load: async () => ({}) }), ctxFor(makeFakePage()));
    expect(gap?.reason).toContain('needs a live browser page');
  });

  it('discloses an analyze that throws', async () => {
    const p = provider(
      { enabled: true },
      {
        load: fakeDequeModule(null, newRecorded(), {
          analyze: async () => {
            throw new Error('ruleset wcag99 not found');
          },
        }),
      },
    );
    const [gap] = await gapsFor(p);
    expect(gap?.reason).toBe('provider deque failed: Deque axe DevTools analysis failed: ruleset wcag99 not found');
  });

  it('turns a hung analyze into a named gap within the timeout', async () => {
    const p = provider(
      { enabled: true },
      { load: fakeDequeModule(null, newRecorded(), { analyze: () => new Promise(() => {}) }), timeoutMs: 50 },
    );
    const started = Date.now();
    const [gap] = await gapsFor(p);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(gap).toEqual({
      ref: 'provider:deque',
      state: 'not-covered',
      reason:
        'provider deque failed: Deque axe DevTools did not finish analysis within 50 ms, so it checked nothing on this screen. Check its license server and the page, or set engines.deque.enabled to false.',
    });
  });

  it('never reads a result that is not axe-shaped as a clean page', async () => {
    for (const results of [null, 'ok', { violations: [] }, { violations: [], incomplete: [], passes: [], inapplicable: 'x' }]) {
      const p = provider({ enabled: true }, { load: fakeDequeModule(results, newRecorded()) });
      const run = await runProviders([p], ctxFor(livePage()), ['live']);
      expect(run.drafts).toEqual([]);
      expect(run.gaps[0]?.reason).toContain('not an axe results object');
    }
  });

  it('is a capability-denied gap when usage tracking needs network that was not granted', async () => {
    const p = provider({ enabled: true, trackUsage: true }, { load: async () => ({}) });
    expect(await gapsFor(p)).toEqual([
      { ref: 'provider:deque', state: 'capability-denied', reason: 'provider deque denied capability: network' },
    ]);
  });

  it('refuses to run unless AXE_TRACK_USAGE is exactly false, before anything from Deque loads', async () => {
    // The package loads and the builder is made before enableTracking(false) can be called, and
    // nothing proves those two steps send no usage data. The variable is the one switch that covers
    // them, so unset is not enough.
    for (const env of [{}, { AXE_TRACK_USAGE: 'true' }, { AXE_TRACK_USAGE: '1' }, { AXE_TRACK_USAGE: '' }, { AXE_TRACK_USAGE: 'FALSE' }]) {
      const recorded = newRecorded();
      let loaded = false;
      const load = fakeDequeModule(await dequeResults(), recorded);
      const p = provider({ enabled: true }, { load: async () => ((loaded = true), load()), env });
      const [gap] = await gapsFor(p);
      expect(gap?.reason).toContain('AXE_TRACK_USAGE is not set to false');
      expect(gap?.reason).toContain("Deque's usage service is on by default");
      expect(gap?.reason).toContain('set AXE_TRACK_USAGE=false, or set engines.deque.enabled to false');
      expect(loaded).toBe(false);
      expect(recorded.constructed).toEqual([]);
    }
  });

  it('runs a builder with no tracking switch, because the variable already turns tracking off', async () => {
    const recorded = newRecorded();
    const p = provider({ enabled: true }, { load: fakeDequeModule(await dequeResults(), recorded, { tracking: false }) });
    const run = await runProviders([p], ctxFor(livePage()), ['live']);
    expect(run.gaps).toEqual([]);
    expect(recorded.calls).toEqual(['analyze']);
  });

  it('refuses a docs screen when the builder cannot limit itself to the docs tags', async () => {
    const recorded = newRecorded();
    const p = provider({ enabled: true }, { load: fakeDequeModule(await dequeResults(), recorded, { tags: false }) });
    const [gap] = await gapsFor(p, ctxFor(livePage(), { profile: 'docs' }));
    expect(gap?.reason).toContain('has no withTags');
    expect(recorded.calls).not.toContain('analyze');
  });
});

describe('Deque refuses to run while a ruleset switch outside the config could replace its rules', () => {
  it('refuses while AXE_RULESET_PATH is set', async () => {
    const recorded = newRecorded();
    const p = provider(
      { enabled: true },
      { load: fakeDequeModule(await dequeResults(), recorded), env: { ...TRACKING_OFF, AXE_RULESET_PATH: '/tmp/empty.json' } },
    );
    const [gap] = (await runProviders([p], ctxFor(livePage()), ['live'])).gaps;
    expect(gap?.reason).toContain('AXE_RULESET_PATH is set');
    expect(gap?.reason).toContain('unset AXE_RULESET_PATH');
    expect(gap?.reason).not.toContain('/tmp/empty.json');
    expect(recorded.calls).toEqual([]);
  });

  it('refuses while axe-ruleset.json is in the project and not guarded', async () => {
    const recorded = newRecorded();
    const p = provider(
      { enabled: true },
      { load: fakeDequeModule(await dequeResults(), recorded), fileExists: async (path) => path.endsWith('axe-ruleset.json') },
    );
    const [gap] = (await runProviders([p], ctxFor(livePage()), ['live'])).gaps;
    expect(gap?.reason).toContain('axe-ruleset.json is in the project');
    expect(gap?.reason).toContain('remove it, or add it to guardedPaths so changing it needs owner approval');
    expect(recorded.calls).toEqual([]);
  });

  it('runs when axe-ruleset.json is listed in guardedPaths', async () => {
    const p = provider(
      { enabled: true },
      { load: fakeDequeModule(await dequeResults(), newRecorded()), fileExists: async (path) => path.endsWith('axe-ruleset.json') },
    );
    const ctx = ctxFor(livePage(), { config: testConfig({ guardedPaths: ['usabl.config.json', 'axe-ruleset.json'] }) });
    const run = await runProviders([p], ctx, ['live']);
    expect(run.gaps).toEqual([]);
    expect(run.drafts).toHaveLength(1);
  });

  it('looks for the file in the working folder it was given', async () => {
    const seen: string[] = [];
    const p = provider(
      { enabled: true },
      {
        load: fakeDequeModule(await dequeResults(), newRecorded()),
        cwd: '/srv/project',
        fileExists: async (path) => {
          seen.push(path);
          return false;
        },
      },
    );
    await p.run(ctxFor(livePage()));
    expect(seen).toEqual(['/srv/project/axe-ruleset.json']);
  });
});
