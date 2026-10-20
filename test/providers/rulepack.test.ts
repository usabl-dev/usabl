import { describe, expect, it, vi } from 'vitest';
import type {
  AxNode,
  Draft,
  ElementRef,
  Page,
  ProfileName,
  ProviderContext,
} from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { draftsOf, gapsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

function element(selector: string): ElementRef {
  return { selector };
}

// An alert's ancestor chain, nearest first, as the page reports it. The first entry is the alert.
type AncestorPlan = Record<string, Array<Record<string, string | null>>>;

function withRulepackPage(
  page: Page,
  queryPlan: Record<string, ElementRef[]>,
  axPlan: Record<string, AxNode | null>,
  ancestorPlan: AncestorPlan = {},
): Page {
  return Object.assign(page, {
    queryAll: async (selector: string) => queryPlan[selector] ?? [],
    // An alert the plan does not name is one the page can no longer find.
    ancestorAttributes: async (selector: string) => {
      const chain = ancestorPlan[selector];
      return chain === undefined ? { kind: 'not-found' as const } : { kind: 'chain' as const, chain };
    },
    axAt: async (selector: string) => {
      if (Object.hasOwn(axPlan, selector)) {
        return axPlan[selector] ?? null;
      }
      return null;
    },
  });
}

async function makeContext(
  queryPlan: Record<string, ElementRef[]>,
  axPlan: Record<string, AxNode | null> = {},
  profile?: ProfileName,
  ancestorPlan: AncestorPlan = {},
): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRulepackPage(page, queryPlan, axPlan, ancestorPlan),
    screen: SCREEN,
    config: testConfig(),
    ...(profile !== undefined ? { profile } : {}),
  };
}

function draftFrom(rule: string): Draft {
  return {
    rule,
    layer: 'pf',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: '.extra',
    elementName: null,
    role: null,
    whatUserExperiences: 'extra check ran',
    why: 'extra check ran',
    fix: 'extra check ran',
    evidence: {},
    confidence: 'fail',
  };
}

describe('makeRulepackProvider', () => {
  it('flags alerts outside live regions and stays silent when all alerts are contained', async () => {
    // Containment is read from each alert's ancestor chain, nearest first. The outside alert has
    // no live value anywhere above it; the inside alert sits in a role="status" region.
    const outsideAlert = element('.outside-alert');
    const insideAlert = element('.inside-alert');
    const ancestors: AncestorPlan = {
      [outsideAlert.selector]: [{ 'aria-live': null, role: null }, { 'aria-live': null, role: null }],
      [insideAlert.selector]: [{ 'aria-live': null, role: null }, { 'aria-live': null, role: 'status' }],
    };
    const provider = makeRulepackProvider();
    const outsideContext = await makeContext(
      { [SEL.alert]: [outsideAlert, insideAlert] },
      {},
      undefined,
      ancestors,
    );

    const outsideDrafts = draftsOf(await provider.run(outsideContext));

    expect(outsideDrafts).toHaveLength(1);
    expect(outsideDrafts[0]).toMatchObject({
      rule: 'pf-toast-live-region',
      confidence: 'fail',
      severity: 'serious',
      elementPath: outsideAlert.selector,
    });

    const insideOnlyContext = await makeContext({ [SEL.alert]: [insideAlert] }, {}, undefined, ancestors);

    const insideOnlyOutput = await provider.run(insideOnlyContext);
    expect(draftsOf(insideOnlyOutput)).toEqual([]);
    expect(gapsOf(insideOnlyOutput)).toEqual([]);
  });

  it('discloses a gap, not a pass, when an alert cannot be found again to read its ancestors', async () => {
    // The alert matched the first query and then vanished. Its containment is unknown, so the check
    // must not pass it: that alert becomes a scoped gap.
    const vanished = element('.vanished-alert');
    const provider = makeRulepackProvider();
    const output = await provider.run(await makeContext({ [SEL.alert]: [vanished] }));

    expect(draftsOf(output).filter((draft) => draft.rule === 'pf-toast-live-region')).toEqual([]);
    expect(gapsOf(output)).toEqual([
      expect.objectContaining({ ref: 'provider:pf-rulepack/pf-toast-live-region', state: 'not-covered' }),
    ]);
    expect(gapsOf(output)[0]?.reason).toContain('.vanished-alert');
  });

  it('keeps checking the other alerts when one alert vanishes', async () => {
    // A toast that closes on a timer must not hide a real violation elsewhere on the screen. The
    // vanished alert is its own gap, and the loose alert is still flagged.
    const vanished = element('.vanished-alert');
    const loose = element('.loose-alert');
    const provider = makeRulepackProvider();
    const output = await provider.run(
      await makeContext({ [SEL.alert]: [vanished, loose] }, {}, undefined, {
        [loose.selector]: [{ 'aria-live': null, role: null }, { 'aria-live': null, role: null }],
      }),
    );

    const toastDrafts = draftsOf(output).filter((draft) => draft.rule === 'pf-toast-live-region');
    expect(toastDrafts.map((draft) => draft.elementPath)).toEqual(['.loose-alert']);
    const toastGaps = gapsOf(output).filter((gap) => gap.ref === 'provider:pf-rulepack/pf-toast-live-region');
    expect(toastGaps).toHaveLength(1);
    expect(toastGaps[0]?.reason).toContain('.vanished-alert');
    expect(toastGaps[0]?.reason).not.toContain('.loose-alert');
  });

  it('discloses a gap when the ancestor walk is cut off at the depth cap', async () => {
    const deep = element('.deep-alert');
    const provider = makeRulepackProvider();
    const context = await makeContext({ [SEL.alert]: [deep] });
    context.page.ancestorAttributes = async () => ({ kind: 'too-deep', limit: 512 });
    const output = await provider.run(context);

    expect(draftsOf(output).filter((draft) => draft.rule === 'pf-toast-live-region')).toEqual([]);
    expect(gapsOf(output)).toEqual([
      expect.objectContaining({ ref: 'provider:pf-rulepack/pf-toast-live-region', state: 'not-covered' }),
    ]);
    expect(gapsOf(output)[0]?.reason).toContain('512');
  });

  it('flags unnamed icon buttons and skips buttons with an AX name', async () => {
    const unnamedButton = element('.icon-button');
    const provider = makeRulepackProvider();
    const unnamedContext = await makeContext(
      {
        [SEL.unnamedButton]: [unnamedButton],
      },
      {
        [unnamedButton.selector]: {
          name: null,
          role: 'button',
          states: {},
        },
      },
    );

    const unnamedDrafts = draftsOf(await provider.run(unnamedContext));

    expect(unnamedDrafts).toHaveLength(1);
    expect(unnamedDrafts[0]).toMatchObject({
      rule: 'pf-icon-button-name',
      confidence: 'fail',
      severity: 'serious',
      elementPath: unnamedButton.selector,
      elementName: null,
    });

    const namedContext = await makeContext(
      {
        [SEL.unnamedButton]: [unnamedButton],
      },
      {
        [unnamedButton.selector]: {
          name: 'Open actions menu',
          role: 'button',
          states: {},
        },
      },
    );

    const namedOutput = await provider.run(namedContext);
    expect(draftsOf(namedOutput)).toEqual([]);
    expect(gapsOf(namedOutput)).toEqual([]);
  });

  it('flags kebab toggles missing expanded or haspopup state and skips complete toggles', async () => {
    const toggle = element('.kebab-toggle');
    const provider = makeRulepackProvider();
    const missingStatesContext = await makeContext(
      {
        [SEL.menuToggle]: [toggle],
      },
      {
        [toggle.selector]: {
          name: 'Row actions',
          role: 'button',
          states: { expanded: false },
        },
      },
    );

    const missingStateDrafts = draftsOf(await provider.run(missingStatesContext));

    expect(missingStateDrafts).toHaveLength(1);
    expect(missingStateDrafts[0]).toMatchObject({
      rule: 'pf-kebab-expanded-state',
      confidence: 'fail',
      severity: 'serious',
      elementPath: toggle.selector,
    });

    const completeStatesContext = await makeContext(
      {
        [SEL.menuToggle]: [toggle],
      },
      {
        [toggle.selector]: {
          name: 'Row actions',
          role: 'button',
          states: { expanded: false, haspopup: 'menu' },
        },
      },
    );

    const completeStatesOutput = await provider.run(completeStatesContext);
    expect(draftsOf(completeStatesOutput)).toEqual([]);
    expect(gapsOf(completeStatesOutput)).toEqual([]);
  });

  it('flags duplicated row action names within a table', async () => {
    const firstDelete = element('tr:nth-child(1) button.delete');
    const secondDelete = element('tr:nth-child(2) button.delete');
    const editAction = element('tr:nth-child(3) button.edit');
    const provider = makeRulepackProvider();
    const ctx = await makeContext(
      {
        [SEL.rowActionButton]: [firstDelete, secondDelete, editAction],
      },
      {
        [firstDelete.selector]: { name: 'Delete', role: 'button', states: {} },
        [secondDelete.selector]: { name: 'Delete', role: 'button', states: {} },
        [editAction.selector]: { name: 'Edit', role: 'button', states: {} },
      },
    );

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((draft) => draft.rule === 'pf-row-action-name-unique')).toBe(true);
  });

  it('flags table headers missing scope and id', async () => {
    const unscopedHeader = element('table th:nth-child(2)');
    const provider = makeRulepackProvider();
    const ctx = await makeContext({
      [SEL.unscopedTh]: [unscopedHeader],
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'pf-table-header-assoc',
      confidence: 'fail',
      severity: 'serious',
      elementPath: unscopedHeader.selector,
    });
  });

  it('flags repeated toolbars when any toolbar lacks an accessible name', async () => {
    const firstToolbar = element('.toolbar-1');
    const secondToolbar = element('.toolbar-2');
    const provider = makeRulepackProvider();
    const repeatedContext = await makeContext(
      {
        [SEL.toolbar]: [firstToolbar, secondToolbar],
      },
      {
        [firstToolbar.selector]: { name: 'Filters', role: 'toolbar', states: {} },
        [secondToolbar.selector]: { name: null, role: 'toolbar', states: {} },
      },
    );

    const repeatedDrafts = draftsOf(await provider.run(repeatedContext));

    expect(repeatedDrafts).toHaveLength(1);
    expect(repeatedDrafts[0]).toMatchObject({
      rule: 'pf-toolbar-labeled-when-repeated',
      confidence: 'fail',
      severity: 'moderate',
      elementPath: secondToolbar.selector,
    });
  });

  it('keeps a single unnamed toolbar silent and advertises live capability', async () => {
    const singleToolbar = element('.single-toolbar');
    const provider = makeRulepackProvider();
    const singleContext = await makeContext(
      {
        [SEL.toolbar]: [singleToolbar],
      },
      {
        [singleToolbar.selector]: { name: null, role: 'toolbar', states: {} },
      },
    );

    const singleOutput = await provider.run(singleContext);
    expect(draftsOf(singleOutput)).toEqual([]);
    expect(gapsOf(singleOutput)).toEqual([]);
    expect(provider.capabilities).toContain('live');
  });

  it('is a no-op on the docs profile: returns empty and runs no checks', async () => {
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-should-not-run')]);
    const provider = makeRulepackProvider([extra]);
    // A toast outside a live region would normally flag on the app profile.
    const outsideAlert = element('.outside-alert');
    const docsContext = await makeContext(
      { [SEL.alert]: [outsideAlert] },
      {},
      'docs',
      { [outsideAlert.selector]: [{ 'aria-live': null, role: null }] },
    );

    const docsOutput = await provider.run(docsContext);
    expect(draftsOf(docsOutput)).toEqual([]);
    expect(gapsOf(docsOutput)).toEqual([]);
    expect(extra).not.toHaveBeenCalled();
  });

  it('still runs its checks on the app profile and when the profile is absent', async () => {
    const appExtra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran-app')]);
    const appProvider = makeRulepackProvider([appExtra]);
    const appContext = await makeContext({}, {}, 'app');

    const appDrafts = draftsOf(await appProvider.run(appContext));

    expect(appExtra).toHaveBeenCalledTimes(1);
    expect(appDrafts).toEqual([draftFrom('extra-ran-app')]);

    const defaultExtra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran-default')]);
    const defaultProvider = makeRulepackProvider([defaultExtra]);
    const defaultContext = await makeContext({});

    const defaultDrafts = draftsOf(await defaultProvider.run(defaultContext));

    expect(defaultExtra).toHaveBeenCalledTimes(1);
    expect(defaultDrafts).toEqual([draftFrom('extra-ran-default')]);
  });

  it('isolates a throwing check: good drafts survive and a disclosed gap names the failing check', async () => {
    // One static check throws (the shape of #196: a duplicate id makes a selector match two
    // elements and Playwright throws a strict-mode violation). The rest of the rulepack must
    // still return its drafts, and the throw must be disclosed as a scoped gap, not swallowed.
    const boom = vi.fn(async (): Promise<Draft[]> => {
      throw new Error('strict mode violation: two elements');
    });
    const provider = makeRulepackProvider([boom]);
    // An unnamed icon button so a real static check produces a draft on the same run.
    const unnamedButton = element('.icon-button');
    const ctx = await makeContext(
      {
        [SEL.unnamedButton]: [unnamedButton],
      },
      {
        [unnamedButton.selector]: { name: null, role: 'button', states: {} },
      },
    );

    const output = await provider.run(ctx);
    const drafts = draftsOf(output);
    const gaps = gapsOf(output);

    expect(boom).toHaveBeenCalledTimes(1);
    // The good check's draft survives the sibling check's throw.
    expect(drafts.some((d) => d.rule === 'pf-icon-button-name')).toBe(true);
    // The throw is disclosed, scoped to this provider, and names the failing check plus the message.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.ref).toBe('provider:pf-rulepack/extra-check-1');
    expect(gaps[0]?.state).toBe('not-covered');
    expect(gaps[0]?.reason).toContain('extra-check-1');
    expect(gaps[0]?.reason).toContain('strict mode violation: two elements');
  });

  it('happy path returns byte-identical drafts and no gaps when no check throws', async () => {
    const unnamedButton = element('.icon-button');
    const plan = {
      [SEL.unnamedButton]: [unnamedButton],
    };
    const ax = {
      [unnamedButton.selector]: { name: null, role: 'button', states: {} },
    };
    const bareProvider = makeRulepackProvider();
    const bareOutput = await bareProvider.run(await makeContext(plan, ax));
    const bareDrafts = draftsOf(bareOutput);

    expect(gapsOf(bareOutput)).toEqual([]);
    expect(bareDrafts.some((d) => d.rule === 'pf-icon-button-name')).toBe(true);
  });
});
