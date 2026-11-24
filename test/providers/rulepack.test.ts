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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRulepackProvider, PF_RULES } from '../../src/providers/rulepack/index.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { applicabilityOf, draftsOf, gapsOf, notesOf, testConfig } from '../helpers.js';

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
  pfMarkers = 1,
  pfMarkersElsewhere = 0,
): Page {
  return Object.assign(page, {
    // pfMarkers sit in the top document, where the rules read. pfMarkersElsewhere sit in frames or
    // shadow roots, which only countEverywhere sees.
    countEverywhere: async (selector: string) => (selector === SEL.pfMarker ? pfMarkers + pfMarkersElsewhere : 0),
    queryAll: async (selector: string) =>
      selector === SEL.pfMarker
        ? Array.from({ length: pfMarkers }, (_, index) => element(`.pf-marker-${index + 1}`))
        : (queryPlan[selector] ?? []),
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
  pfMarkers = 1,
  pfMarkersElsewhere = 0,
): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRulepackPage(page, queryPlan, axPlan, ancestorPlan, pfMarkers, pfMarkersElsewhere),
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

  // A toggle whose attributes match its accessibility tree state. The toggle that declares a menu
  // opens one and moves focus into it, as a correct toggle does. The other declares no menu and opens
  // none, so the menu probe waits its full 2.5 seconds for a menu and then says nothing. That wait is
  // the probe's real cost on such a toggle, so this test needs more than the default 5 seconds.
  async function kebabContext(toggle: ElementRef, attributes: Record<string, string>, opensMenu: boolean): Promise<ProviderContext> {
    const menu = element('.kebab-menu');
    let open = false;
    const states: Record<string, unknown> = {};
    if (attributes['aria-expanded'] !== undefined) {
      states['expanded'] = attributes['aria-expanded'] === 'true';
    }
    if (attributes['aria-haspopup'] !== undefined) {
      states['haspopup'] = attributes['aria-haspopup'];
    }
    const ctx = await makeContext({ [SEL.menuToggle]: [toggle] }, { [toggle.selector]: { name: 'Row actions', role: 'button', states } });
    const queryAll = ctx.page.queryAll.bind(ctx.page);
    const axAt = ctx.page.axAt.bind(ctx.page);
    Object.assign(ctx.page, {
      queryAll: async (selector: string) => (selector === SEL.menu ? (open ? [menu] : []) : queryAll(selector)),
      axAt: async (selector: string) => (selector === menu.selector && open ? { name: 'Row actions', role: 'menu', states: {} } : axAt(selector)),
      getAttribute: async (selector: string, name: string) => (selector === toggle.selector ? (attributes[name] ?? null) : null),
      click: async (selector: string) => {
        if (selector === toggle.selector && opensMenu) {
          open = true;
        }
      },
      press: async (key: string) => {
        if (key === 'Escape') {
          open = false;
        }
      },
      activeElementWithin: async (selector: string) => selector === menu.selector && open,
    });
    return ctx;
  }

  it('flags kebab toggles missing expanded or haspopup state and skips complete toggles', { timeout: 15_000 }, async () => {
    const toggle = element('.kebab-toggle');
    const provider = makeRulepackProvider();
    const missingStatesContext = await kebabContext(toggle, { 'aria-expanded': 'false' }, false);

    const missingStateDrafts = draftsOf(await provider.run(missingStatesContext));

    expect(missingStateDrafts).toHaveLength(1);
    expect(missingStateDrafts[0]).toMatchObject({
      rule: 'pf-kebab-expanded-state',
      confidence: 'fail',
      severity: 'serious',
      elementPath: toggle.selector,
    });

    const completeStatesContext = await kebabContext(toggle, { 'aria-expanded': 'false', 'aria-haspopup': 'menu' }, true);

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

  it('reports every rule inapplicable on a page with no PatternFly marker, and runs no check', async () => {
    // Some selectors have generic ARIA arms, and the dialog probe clicks disclosure controls, so on a
    // page built with another design system they would report PatternFly rules against markup
    // PatternFly never made. An alert outside a live region would flag here if the pack ran.
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran')]);
    const provider = makeRulepackProvider([extra]);
    const ctx = await makeContext({ [SEL.alert]: [element('.outside-alert')] }, {}, 'app', {}, 0);

    const output = await provider.run(ctx);

    expect(draftsOf(output)).toEqual([]);
    expect(gapsOf(output)).toEqual([]);
    expect(extra).not.toHaveBeenCalled();
    expect(applicabilityOf(output)).toEqual(
      [
        'pf-focus-into-dialog',
        'pf-icon-button-name',
        'pf-kebab-expanded-state',
        'pf-modal-focus-return',
        'pf-row-action-name-unique',
        'pf-table-header-assoc',
        'pf-toast-live-region',
        'pf-toolbar-labeled-when-repeated',
      ].map((rule) => ({ screenId: SCREEN.id, layer: 'pf', rule, outcome: 'inapplicable', elementCount: 0 })),
    );
  });

  it('does not run when PatternFly markup sits only in frames or shadow roots, and discloses it in a note, never a gap', async () => {
    // The rules read the top document. A PatternFly widget inside a frame must not switch the pack
    // on for a top document with no PatternFly, where its generic ARIA arms would fire.
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran')]);
    const ctx = await makeContext({ [SEL.unnamedButton]: [element('#plain')] }, {}, 'app', {}, 0, 3);

    const output = await makeRulepackProvider([extra]).run(ctx);

    expect(draftsOf(output)).toEqual([]);
    expect(extra).not.toHaveBeenCalled();
    expect(applicabilityOf(output)).toHaveLength(PF_RULES.length);
    expect(applicabilityOf(output).every((entry) => entry.outcome === 'inapplicable' && entry.elementCount === 0)).toBe(true);
    // A note, not a gap: the screen is not blocked because an optional pack could not read there.
    expect(gapsOf(output)).toEqual([]);
    expect(notesOf(output)).toEqual([
      {
        ref: 'provider:pf-rulepack/out-of-document',
        reason:
          '3 PatternFly element(s) sit inside frames or shadow roots, which the PatternFly rulepack does not read, so the PatternFly rules did not check them.',
      },
    ]);
  });

  it('runs with no gap when the top document has PatternFly markup and more sits elsewhere', async () => {
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran')]);
    const output = await makeRulepackProvider([extra]).run(await makeContext({}, {}, 'app', {}, 1, 4));

    expect(draftsOf(output)).toEqual([draftFrom('extra-ran')]);
    expect(gapsOf(output)).toEqual([]);
    expect(notesOf(output)).toEqual([]);
  });

  it('runs on a page that carries a PatternFly marker and reports no applicability of its own', async () => {
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran')]);
    const output = await makeRulepackProvider([extra]).run(await makeContext({}, {}, 'app', {}, 3));

    expect(draftsOf(output)).toEqual([draftFrom('extra-ran')]);
    expect(applicabilityOf(output)).toEqual([]);
  });

  it('lists every rule id the checks and probes write, so the inapplicable record misses none', () => {
    // Every pf- literal in the rulepack source is a rule id, except the class prefixes of the marker
    // and the provider id. A new rule that is left out of PF_RULES fails here.
    const dir = join(process.cwd(), 'src/providers/rulepack');
    const literals = new Set(
      readdirSync(dir)
        .filter((file) => file.endsWith('.ts'))
        .flatMap((file) => [...readFileSync(join(dir, file), 'utf8').matchAll(/'(pf-[a-z0-9-]+)'/g)].map((match) => match[1] ?? '')),
    );
    for (const notRule of ['pf-v6-', 'pf-v5-', 'pf-c-', 'pf-m-', 'pf-l-', 'pf-u-', 'pf-rulepack']) literals.delete(notRule);
    expect([...literals].sort()).toEqual([...PF_RULES]);
  });

  it('recognizes PatternFly by class token prefix or by an OUIA type, never by substring', () => {
    expect(SEL.pfMarker).toBe(
      [
        '[class^="pf-v6-"]',
        '[class*=" pf-v6-"]',
        '[class^="pf-v5-"]',
        '[class*=" pf-v5-"]',
        '[class^="pf-c-"]',
        '[class*=" pf-c-"]',
        '[class^="pf-m-"]',
        '[class*=" pf-m-"]',
        '[class^="pf-l-"]',
        '[class*=" pf-l-"]',
        '[class^="pf-u-"]',
        '[class*=" pf-u-"]',
        '[data-ouia-component-type^="PF"]',
      ].join(', '),
    );
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

describe('pf-toast-live-region: a toast group hidden by an open modal dialog', () => {
  const alertRef = element('.toast-alert');
  const modal = element('.open-modal');
  const ALERT_ENTRY = { 'aria-live': null, role: null, class: 'pf-v6-c-alert pf-m-success' };
  const BODY = { 'aria-live': null, role: null };
  const HTML = { 'aria-live': null, role: null };

  // A page with one alert whose chain is given, nearest first and ending at the body and the root
  // element. With modalOpen, an exposed role="dialog" aria-modal="true" element is on the page.
  async function toastDrafts(chain: Array<Record<string, string | null>>, modalOpen: boolean): Promise<Draft[]> {
    const queryPlan: Record<string, ElementRef[]> = {
      [SEL.alert]: [alertRef],
      ':root > body': [element('body')],
      ...(modalOpen ? { '[aria-modal]': [modal] } : {}),
    };
    const axPlan: Record<string, AxNode | null> = {
      [alertRef.selector]: { name: 'Saved', role: 'generic', states: {} },
      ...(modalOpen ? { [modal.selector]: { name: 'Edit cluster', role: 'dialog', states: {} } } : {}),
    };
    const context = await makeContext(queryPlan, axPlan, undefined, { [alertRef.selector]: chain });
    const modalAttributes: Record<string, string> = { role: 'dialog', 'aria-modal': 'true' };
    context.page.getAttribute = async (selector: string, name: string) =>
      selector === modal.selector ? (modalAttributes[name] ?? null) : null;
    const output = await makeRulepackProvider().run(context);
    expect(gapsOf(output)).toEqual([]);
    return draftsOf(output).filter((draft) => draft.rule === 'pf-toast-live-region');
  }

  // PatternFly places a toast group under the body. Here the group is the body's child, is live,
  // and is hidden, as a modal hides the body's other children.
  const hiddenLiveGroup = [
    ALERT_ENTRY,
    { 'aria-live': 'polite', role: null, 'aria-hidden': 'true', class: 'pf-v6-c-alert-group pf-m-toast' },
    BODY,
    HTML,
  ];

  it('reports one undecided draft for a hidden toast group under the body while a modal is open', async () => {
    const drafts = await toastDrafts(hiddenLiveGroup, true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ confidence: 'unverified', elementPath: '.toast-alert', elementName: 'Saved' });
    expect(drafts[0]?.why).toContain('An open dialog hides the toast area from screen readers');
    expect(drafts[0]?.why).toContain('may not be announced');
    expect(drafts[0]?.fix).toContain('check whether alerts can appear while this dialog is open');
  });

  it('reports one undecided draft when the hidden body child holds a live toast group, as PatternFly renders it', async () => {
    // PatternFly portals the toast group into a plain div under the body, and the modal sets
    // aria-hidden on that div.
    const chain = [
      ALERT_ENTRY,
      { 'aria-live': null, role: null },
      { 'aria-live': 'polite', role: 'list', class: 'pf-v6-c-alert-group pf-m-toast' },
      { 'aria-live': null, role: null, 'aria-hidden': 'true' },
      BODY,
      HTML,
    ];
    const drafts = await toastDrafts(chain, true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('An open dialog hides the toast area from screen readers');
  });

  it('still fails a hidden toast group when no modal is open', async () => {
    const drafts = await toastDrafts(hiddenLiveGroup, false);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('fail');
    expect(drafts[0]?.why).toContain('hidden from assistive technology');
  });

  it('still passes a toast group under the body that is not hidden, with a modal open or not', async () => {
    const shown = [ALERT_ENTRY, { 'aria-live': 'polite', role: null, class: 'pf-v6-c-alert-group pf-m-toast' }, BODY, HTML];
    expect(await toastDrafts(shown, true)).toEqual([]);
    expect(await toastDrafts(shown, false)).toEqual([]);
  });

  it('still passes an alert in a live region inside the hidden app root while a modal is open', async () => {
    // The app root is not a toast group or a live region. The modal hides it on purpose.
    const chain = [
      ALERT_ENTRY,
      { 'aria-live': 'polite', role: null },
      { 'aria-live': null, role: null, 'aria-hidden': 'true', id: 'root' },
      BODY,
      HTML,
    ];
    expect(await toastDrafts(chain, true)).toEqual([]);
  });

  it('still fails a toast group whose own container below the body child is hidden, with a modal open', async () => {
    const chain = [
      ALERT_ENTRY,
      { 'aria-live': 'polite', role: null, class: 'pf-v6-c-alert-group pf-m-toast' },
      { 'aria-live': null, role: null, 'aria-hidden': 'true' },
      { 'aria-live': null, role: null },
      BODY,
      HTML,
    ];
    const drafts = await toastDrafts(chain, true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('fail');
  });

  // The next cases carry no toast group class, so only the live region part of the rule can find
  // them.
  it('reports one undecided draft when the hidden body child is itself the live region, with no toast group class', async () => {
    for (const live of [{ 'aria-live': 'polite', role: null }, { 'aria-live': null, role: 'status' }]) {
      const chain = [ALERT_ENTRY, { ...live, 'aria-hidden': 'true' }, BODY, HTML];
      const drafts = await toastDrafts(chain, true);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.confidence).toBe('unverified');
      expect(drafts[0]?.why).toContain('An open dialog hides the toast area from screen readers');
    }
  });

  it('reports one undecided draft when the body is live and the hidden body child sits inside it', async () => {
    for (const liveTop of [
      [{ 'aria-live': 'polite', role: null }, HTML],
      [BODY, { 'aria-live': 'polite', role: null }],
    ]) {
      const chain = [ALERT_ENTRY, { 'aria-live': null, role: null, 'aria-hidden': 'true' }, ...liveTop];
      const drafts = await toastDrafts(chain, true);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.confidence).toBe('unverified');
      expect(drafts[0]?.why).toContain('An open dialog hides the toast area from screen readers');
    }
  });
});

describe('pf-toast-live-region: an empty toast group hidden by an open modal dialog', () => {
  // PatternFly renders the toast group as soon as a toast AlertGroup mounts, before any alert is in
  // it: a list inside a plain div under the body. A modal sets aria-hidden on that div.
  const TOAST_GROUP_SELECTOR = '[class~="pf-v6-c-alert-group"][class~="pf-m-toast"]';
  const group = element('.toast-group');
  const alertRef = element('.toast-alert');
  const modal = element('.open-modal');
  const GROUP_ENTRY = { 'aria-live': 'polite', role: 'list', class: 'pf-v6-c-alert-group pf-m-toast' };
  const BODY = { 'aria-live': null, role: null };
  const HTML = { 'aria-live': null, role: null };
  const HIDDEN_PORTAL = { 'aria-live': null, role: null, 'aria-hidden': 'true' };
  const SHOWN_PORTAL = { 'aria-live': null, role: null };

  // A page with one toast group, its chain given nearest first. With holdsAlert, an alert sits in
  // the group. With modalOpen, an exposed role="dialog" aria-modal="true" element is on the page.
  async function groupDrafts(portal: Record<string, string | null>, modalOpen: boolean, holdsAlert: boolean): Promise<Draft[]> {
    const groupChain = [GROUP_ENTRY, portal, BODY, HTML];
    const queryPlan: Record<string, ElementRef[]> = {
      [TOAST_GROUP_SELECTOR]: [group],
      ':root > body': [element('body')],
      ...(modalOpen ? { '[aria-modal]': [modal] } : {}),
      ...(holdsAlert ? { [SEL.alert]: [alertRef], [`${group.selector} ${SEL.alert}`]: [alertRef] } : {}),
    };
    const axPlan: Record<string, AxNode | null> = modalOpen
      ? { [modal.selector]: { name: 'Edit cluster', role: 'dialog', states: {} } }
      : {};
    const ancestors: AncestorPlan = {
      [group.selector]: groupChain,
      [alertRef.selector]: [{ 'aria-live': null, role: null, class: 'pf-v6-c-alert' }, { 'aria-live': null, role: 'listitem' }, ...groupChain],
    };
    const context = await makeContext(queryPlan, axPlan, undefined, ancestors);
    const modalAttributes: Record<string, string> = { role: 'dialog', 'aria-modal': 'true' };
    context.page.getAttribute = async (selector: string, name: string) =>
      selector === modal.selector ? (modalAttributes[name] ?? null) : null;
    const output = await makeRulepackProvider().run(context);
    expect(gapsOf(output)).toEqual([]);
    return draftsOf(output).filter((draft) => draft.rule === 'pf-toast-live-region');
  }

  it('reports one undecided draft on an empty toast group hidden by an open modal', async () => {
    const drafts = await groupDrafts(HIDDEN_PORTAL, true, false);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ confidence: 'unverified', elementPath: '.toast-group' });
    expect(drafts[0]?.why).toContain('An open dialog hides the toast area from screen readers');
    expect(drafts[0]?.why).toContain('may not be announced');
    expect(drafts[0]?.fix).toContain('check whether alerts can appear while this dialog is open');
    expect(JSON.stringify(drafts[0])).not.toContain('pf-m-toast');
  });

  it('reports nothing new for the same hidden empty group when no modal is open', async () => {
    expect(await groupDrafts(HIDDEN_PORTAL, false, false)).toEqual([]);
  });

  it('reports one draft, from the alert, for a hidden toast group that holds an alert', async () => {
    const drafts = await groupDrafts(HIDDEN_PORTAL, true, true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ confidence: 'unverified', elementPath: '.toast-alert' });
  });

  it('reports nothing for an empty toast group that is not hidden while a modal is open', async () => {
    expect(await groupDrafts(SHOWN_PORTAL, true, false)).toEqual([]);
  });
});
