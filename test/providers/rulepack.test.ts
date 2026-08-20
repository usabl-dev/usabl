import { describe, expect, it } from 'vitest';
import type { AxNode, ElementRef, Page, ProviderContext } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

function element(selector: string): ElementRef {
  return { selector };
}

function withRulepackPage(
  page: Page,
  queryPlan: Record<string, ElementRef[]>,
  axPlan: Record<string, AxNode | null>,
): Page {
  return Object.assign(page, {
    queryAll: async (selector: string) => queryPlan[selector] ?? [],
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
): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRulepackPage(page, queryPlan, axPlan),
    screen: SCREEN,
    config: testConfig(),
  };
}

describe('makeRulepackProvider', () => {
  it('flags alerts outside live regions and stays silent when all alerts are contained', async () => {
    const outsideAlert = element('.outside-alert');
    const insideAlert = element('.inside-alert');
    const provider = makeRulepackProvider();
    const outsideContext = await makeContext({
      [SEL.alert]: [outsideAlert, insideAlert],
      [`${SEL.liveContainer} ${SEL.alert}`]: [insideAlert],
    });

    const outsideDrafts = await provider.run(outsideContext);

    expect(outsideDrafts).toHaveLength(1);
    expect(outsideDrafts[0]).toMatchObject({
      rule: 'pf-toast-live-region',
      confidence: 'fail',
      severity: 'serious',
      elementPath: outsideAlert.selector,
    });

    const insideOnlyContext = await makeContext({
      [SEL.alert]: [insideAlert],
      [`${SEL.liveContainer} ${SEL.alert}`]: [insideAlert],
    });

    await expect(provider.run(insideOnlyContext)).resolves.toEqual([]);
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

    const unnamedDrafts = await provider.run(unnamedContext);

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

    await expect(provider.run(namedContext)).resolves.toEqual([]);
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

    const missingStateDrafts = await provider.run(missingStatesContext);

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

    await expect(provider.run(completeStatesContext)).resolves.toEqual([]);
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

    const drafts = await provider.run(ctx);

    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((draft) => draft.rule === 'pf-row-action-name-unique')).toBe(true);
  });

  it('flags table headers missing scope and id', async () => {
    const unscopedHeader = element('table th:nth-child(2)');
    const provider = makeRulepackProvider();
    const ctx = await makeContext({
      [SEL.unscopedTh]: [unscopedHeader],
    });

    const drafts = await provider.run(ctx);

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

    const repeatedDrafts = await provider.run(repeatedContext);

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

    await expect(provider.run(singleContext)).resolves.toEqual([]);
    expect(provider.capabilities).toContain('live');
  });
});
