/**
 * The sensitivity runner on fake pages, through the real check runner and the real gate. Each
 * outcome is reached here: caught, caught by another rule (on the element and elsewhere), missed,
 * preview only, not applicable, and unreadable. The clean scan is never mutated, the edit lands
 * before any provider runs, and every page the runner opens is closed.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserDriver, Draft, Page, Provider, ProviderContext, RequirementBundle } from '../../../src/contracts/index.js';
import { makeCheckRunner } from '../../../src/providers/check-runner.js';
import { makeStepRunner } from '../../../src/providers/keyboard-walk/steps.js';
import { makeMutatingBrowser } from '../../../src/measure/sensitivity/browser.js';
import type { CatalogEntry } from '../../../src/measure/sensitivity/catalog.js';
import type { EditCheck } from '../../../src/measure/sensitivity/edits.js';
import { makeFakeDom, makeFakeDomPage, makeFakeMutationEditor } from '../../../src/measure/sensitivity/fakes.js';
import { measureCatalog, measureEntry, type SensitivityScreen } from '../../../src/measure/sensitivity/runner.js';
import { testConfig } from '../../helpers.js';

const SCREEN: SensitivityScreen = { id: 'basic', url: 'http://127.0.0.1:5173/basic' };
const NOW = '2026-11-09T00:00:00.000Z';
const EMPTY: RequirementBundle = { version: 1, requirements: [] };

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'button-name-removed',
    description: 'A button loses every source of its accessible name.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['button-name'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: { selector: 'button', tree: { roles: ['button'], named: true } }, edit: { kind: 'remove-text-name' } },
    ...overrides,
  };
}

function freshDom() {
  return makeFakeDom({
    elements: [
      { path: 'main', role: 'main', name: null },
      { path: '#save', parent: 'main', role: 'button', name: 'Save', text: 'Save' },
      { path: '#other', parent: 'main', role: 'button', name: 'Other', text: 'Other' },
    ],
    selectors: { button: ['#save', '#other'] },
  });
}

function draft(ctx: ProviderContext, rule: string, elementPath: string, overrides: Partial<Draft> = {}): Draft {
  return {
    rule,
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath,
    elementName: null,
    role: 'button',
    whatUserExperiences: 'A button has no name.',
    why: 'why',
    fix: 'fix',
    evidence: {},
    confidence: 'fail',
    ...overrides,
  };
}

// Reports `rule` on `reportAt` whenever the button at #save has lost its name.
function namesProvider(rule = 'button-name', reportAt = '#save', overrides: Partial<Draft> = {}): Provider {
  return {
    id: `fake-${rule}`,
    layer: 'axe',
    capabilities: ['live'],
    async run(ctx) {
      const node = await ctx.page.axAt('#save');
      return node?.name === '' ? [draft(ctx, rule, reportAt, overrides)] : [];
    },
  };
}

interface Harness {
  opened: number;
  closed: number;
  pages: Page[];
}

function setup(providers: Provider[], options: { refuse?: string; check?: EditCheck } = {}) {
  const harness: Harness = { opened: 0, closed: 0, pages: [] };
  const base: BrowserDriver = {
    async open(url) {
      harness.opened += 1;
      const page = makeFakeDomPage(freshDom(), {
        currentUrl: async () => url,
        close: async () => {
          harness.closed += 1;
        },
      });
      harness.pages.push(page);
      return page;
    },
    close: async () => {},
  };
  const browser = makeMutatingBrowser(base, makeFakeMutationEditor(options));
  const checkRunner = makeCheckRunner({
    browser,
    providers,
    config: testConfig({ surfaces: [] }),
    allowedCapabilities: ['live'],
    stepRunner: makeStepRunner(),
    transcriptTabCap: 0,
  });
  return { harness, deps: { checkRunner, browser, requirements: EMPTY, now: NOW } };
}

describe('measureEntry', () => {
  it('is caught when an expected rule reports the mutated element as new', async () => {
    const { deps, harness } = setup([namesProvider()]);
    expect(await measureEntry(deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'caught',
      rules: ['button-name'],
      reason: null,
    });
    expect(harness.opened).toBe(2);
    expect(harness.closed).toBe(2);
  });

  it('scans the clean page unchanged and makes the edit before any provider runs', async () => {
    const seen: Array<string | null> = [];
    const watcher: Provider = {
      id: 'watcher',
      layer: 'axe',
      capabilities: ['live'],
      async run(ctx) {
        seen.push((await ctx.page.axAt('#save'))?.name ?? null);
        return [];
      },
    };
    const { deps } = setup([watcher, namesProvider()]);
    await measureEntry(deps, entry(), SCREEN);
    expect(seen).toEqual(['Save', '']);
  });

  it('does not count a barrier the clean page already had', async () => {
    const always: Provider = {
      id: 'always',
      layer: 'axe',
      capabilities: ['live'],
      run: async (ctx) => [draft(ctx, 'button-name', '#other')],
    };
    const { deps } = setup([always]);
    expect((await measureEntry(deps, entry(), SCREEN)).outcome).toBe('missed');

    const both = setup([always, namesProvider()]);
    expect(await measureEntry(both.deps, entry(), SCREEN)).toMatchObject({ outcome: 'caught', rules: ['button-name'] });
  });

  it('does not count a finding the page already had when the edit changes the name its identity was keyed on', async () => {
    // The clean page already fails target-size on #save. The identity is keyed on the name "Save",
    // and the edit removes that name, so the same finding comes back under a new identity.
    const keyedOnName: Provider = {
      id: 'keyed-on-name',
      layer: 'axe',
      capabilities: ['live'],
      async run(ctx) {
        const name = (await ctx.page.axAt('#save'))?.name ?? null;
        return [
          draft(ctx, 'target-size', '#save', {
            elementName: name,
            evidence: name === null || name === '' ? {} : { name: { value: name, source: 'ax-tree', fromTree: true } },
          }),
        ];
      },
    };
    const { deps } = setup([keyedOnName]);
    expect(await measureEntry(deps, entry(), SCREEN)).toMatchObject({ outcome: 'missed', rules: [] });

    const both = setup([keyedOnName, namesProvider()]);
    expect(await measureEntry(both.deps, entry(), SCREEN)).toMatchObject({ outcome: 'caught', rules: ['button-name'] });
  });

  it('is not applicable when an expected rule already reports the target on the clean page', async () => {
    const already: Provider = {
      id: 'already',
      layer: 'axe',
      capabilities: ['live'],
      run: async (ctx) => [draft(ctx, 'button-name', '#save')],
    };
    const { deps, harness } = setup([already]);
    expect(await measureEntry(deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'not applicable',
      rules: [],
      reason: 'the defect was already on this element before the edit',
    });
    expect(harness.closed).toBe(harness.opened);

    // Another rule on the target before the edit is not the defect.
    const other = setup([{ ...already, run: async (ctx) => [draft(ctx, 'color-contrast', '#save')] }, namesProvider()]);
    expect((await measureEntry(other.deps, entry(), SCREEN)).outcome).toBe('caught');
  });

  it('is unreadable, not caught, when the only new gating finding is unverified', async () => {
    const { deps } = setup([namesProvider('button-name', '#save', { confidence: 'unverified' })]);
    expect(await measureEntry(deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'unreadable',
      rules: ['button-name'],
      reason: 'the checks could not confirm the defect either way: button-name',
    });
  });

  it('counts only the definite failure when a definite and an unverified finding are new', async () => {
    const { deps } = setup([namesProvider('button-name', '#save'), namesProvider('color-contrast', '#save', { confidence: 'unverified' })]);
    expect(await measureEntry(deps, entry({ expectedRules: ['color-contrast'] }), SCREEN)).toMatchObject({
      outcome: 'caught by another rule',
      rules: ['button-name'],
    });
  });

  it('is caught by another rule when a different rule reports the mutated element', async () => {
    const { deps } = setup([namesProvider()]);
    expect(await measureEntry(deps, entry({ expectedRules: ['link-name'] }), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'caught by another rule',
      rules: ['button-name'],
      reason: 'reported by button-name; expected link-name',
    });
  });

  it('is unreadable when the only new finding is away from the mutated element, because the two loads differ', async () => {
    const { deps } = setup([namesProvider('button-name', '#other')]);
    expect(await measureEntry(deps, entry(), SCREEN)).toMatchObject({
      outcome: 'unreadable',
      rules: ['button-name'],
      reason:
        'a new finding appeared away from the change, so the two loads differ and this proves nothing about the defect: button-name',
    });
  });

  it('accepts a finding anywhere on the screen for an entry reported on the screen', async () => {
    const { deps } = setup([namesProvider('button-name', '#other')]);
    expect((await measureEntry(deps, entry({ reportedOn: 'screen' }), SCREEN)).outcome).toBe('caught');
  });

  it('accepts a finding on the element that holds the target for an entry reported around it', async () => {
    const { deps } = setup([namesProvider('button-name', 'main')]);
    expect((await measureEntry(deps, entry({ reportedOn: 'around-target' }), SCREEN)).outcome).toBe('caught');
    const inside = setup([namesProvider('button-name', 'main')]);
    expect((await measureEntry(inside.deps, entry({ reportedOn: 'inside-target' }), SCREEN)).outcome).toBe('unreadable');
  });

  it('is missed when nothing new gates, and names what was expected', async () => {
    const { deps } = setup([]);
    expect(await measureEntry(deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'missed',
      rules: [],
      reason: 'nothing new gated; expected button-name',
    });
    expect(await measureEntry(deps, entry({ expectedRules: [], noShippedRule: 'No rule.' }), SCREEN)).toMatchObject({
      outcome: 'missed',
      reason: 'nothing new gated; no shipped rule claims this defect',
    });
  });

  it('is preview only when the only new finding is preview class', async () => {
    const { deps } = setup([namesProvider('intake:save/missing-announcement', '#save', { evidenceClass: 'preview', confidence: 'unverified' })]);
    expect(await measureEntry(deps, entry({ expectedRules: ['intake:*'], expectedClass: 'preview' }), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'preview only',
      rules: ['intake:save/missing-announcement'],
      reason: 'only preview findings were new, and preview never gates: intake:save/missing-announcement',
    });
  });

  it('is not applicable when no element on the page can carry the defect', async () => {
    const { deps, harness } = setup([namesProvider()]);
    expect(await measureEntry(deps, entry({ mutation: { target: { selector: 'img[alt]' }, edit: { kind: 'remove-attribute', names: ['alt'] } } }), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'not applicable',
      rules: [],
      reason: 'no element on the page matches the target selector',
    });
    expect(harness.closed).toBe(harness.opened);
  });

  it('is not applicable, without loading the page, when the screen lacks what the entry needs', async () => {
    const { deps, harness } = setup([namesProvider()]);
    expect(await measureEntry(deps, entry({ needs: { requirement: 'flow' } }), SCREEN)).toMatchObject({
      outcome: 'not applicable',
      reason: 'no flow requirement with an expected announcement names this screen',
    });
    expect(await measureEntry(deps, entry({ needs: { profile: 'docs' } }), SCREEN)).toMatchObject({
      outcome: 'not applicable',
      reason: 'the defect is checked on documentation pages, and this screen is not one',
    });
    expect(harness.opened).toBe(0);
  });

  it('runs an entry that needs a flow requirement on a screen one names', async () => {
    const { deps } = setup([namesProvider()]);
    const requirements: RequirementBundle = {
      version: 1,
      requirements: [
        {
          id: 'save',
          kind: 'flow',
          surface: 'basic',
          description: 'Saving announces it.',
          approved: true,
          assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
        },
      ],
    };
    expect((await measureEntry({ ...deps, requirements }, entry({ needs: { requirement: 'flow' } }), SCREEN)).outcome).toBe('caught');
  });

  it('is unreadable when the clean scan has a coverage gap', async () => {
    let scans = 0;
    const flaky: Provider = {
      id: 'flaky',
      layer: 'axe',
      capabilities: ['live'],
      async run() {
        scans += 1;
        if (scans === 1) throw new Error('lost the page');
        return [];
      },
    };
    const { deps, harness } = setup([flaky, namesProvider()]);
    expect(await measureEntry(deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'unreadable',
      rules: [],
      reason: 'the clean scan had a coverage gap, so it proves nothing: provider flaky failed: lost the page',
    });
    expect(harness.opened).toBe(1);
  });

  it('is unreadable when the mutated scan has a coverage gap, even if a rule fired', async () => {
    let scans = 0;
    const flaky: Provider = {
      id: 'flaky',
      layer: 'axe',
      capabilities: ['live'],
      async run() {
        scans += 1;
        if (scans === 2) throw new Error('lost the page');
        return [];
      },
    };
    const { deps, harness } = setup([flaky, namesProvider()]);
    expect(await measureEntry(deps, entry(), SCREEN)).toMatchObject({
      outcome: 'unreadable',
      reason: 'the mutated scan had a coverage gap, so it proves nothing: provider flaky failed: lost the page',
    });
    expect(harness.closed).toBe(2);
  });

  it('is unreadable when the edit did not hold', async () => {
    const { deps } = setup([namesProvider()], { refuse: 'the page kept a text name the edit removed' });
    expect(await measureEntry(deps, entry(), SCREEN)).toMatchObject({
      outcome: 'unreadable',
      reason: 'the mutation was not made: the page kept a text name the edit removed',
    });
  });

  it('is unreadable when the change did not hold through the scan, even if a rule fired', async () => {
    const reason = 'the page put back an attribute the edit removed';
    const quiet = setup([], { check: { held: false, reason } });
    expect(await measureEntry(quiet.deps, entry(), SCREEN)).toEqual({
      entry: 'button-name-removed',
      screen: 'basic',
      outcome: 'unreadable',
      rules: [],
      reason: `the change did not hold through the scan, so it proves nothing: ${reason}`,
    });
    const loud = setup([namesProvider()], { check: { held: false, reason } });
    expect((await measureEntry(loud.deps, entry(), SCREEN)).outcome).toBe('unreadable');
  });

  it('says in a miss when the checks never pressed the key the edit cancels', async () => {
    const note = 'the checks never pressed Enter on the changed element';
    const { deps } = setup([], { check: { held: true, note } });
    expect(await measureEntry(deps, entry({ expectedRules: [], noShippedRule: 'No rule.' }), SCREEN)).toMatchObject({
      outcome: 'missed',
      reason: `nothing new gated; ${note}; no shipped rule claims this defect`,
    });
    const caughtAnyway = setup([namesProvider()], { check: { held: true, note } });
    expect(await measureEntry(caughtAnyway.deps, entry(), SCREEN)).toMatchObject({ outcome: 'caught', reason: null });
  });

  it('is unreadable when a capability is denied, because a denied provider is a gap', async () => {
    const { deps } = setup([namesProvider(), { ...namesProvider('other'), capabilities: ['network'] }]);
    expect((await measureEntry(deps, entry(), SCREEN)).outcome).toBe('unreadable');
  });
});

describe('measureCatalog', () => {
  it('measures every entry on each of its screens in order', async () => {
    const { deps } = setup([namesProvider()]);
    const second: SensitivityScreen = { id: 'second', url: 'http://127.0.0.1:5173/second' };
    const results = await measureCatalog(deps, [
      { entry: entry(), screens: [SCREEN, second] },
      { entry: entry({ id: 'other-entry', expectedRules: ['link-name'] }), screens: [SCREEN] },
    ]);
    expect(results.map((measurement) => [measurement.entry, measurement.screen, measurement.outcome])).toEqual([
      ['button-name-removed', 'basic', 'caught'],
      ['button-name-removed', 'second', 'caught'],
      ['other-entry', 'basic', 'caught by another rule'],
    ]);
  });
});
