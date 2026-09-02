import { describe, expect, it } from 'vitest';
import type { AxNode, ElementRef, Page, ProviderContext } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

function element(selector: string): ElementRef {
  return { selector };
}

function axNode(name: string, role: string): AxNode {
  return { name, role, states: {} };
}

async function makeDialogContext(options: {
  openOnClick: boolean;
  focusMovesIntoDialog: boolean;
  focusReturnsToTrigger: boolean;
  // SEL.dialogTrigger also matches plain disclosure controls, which promise nothing about
  // dialogs. Default to the declared trigger, the case where a missing dialog is a finding.
  declaresDialog?: boolean;
}): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  const trigger = element('#dialog-trigger');
  const dialog = element('#dialog');
  let isOpen = false;

  const scriptedPage: Page = Object.assign(page, {
    queryAll: async (selector: string) => {
      if (selector === SEL.dialogTrigger) {
        return [trigger];
      }
      if (selector === SEL.dialog) {
        return isOpen ? [dialog] : [];
      }
      return [];
    },
    axAt: async (selector: string) => {
      if (selector === trigger.selector) {
        return axNode('Open details', 'button');
      }
      if (selector === dialog.selector) {
        return axNode('Details modal', 'dialog');
      }
      return null;
    },
    getAttribute: async (selector: string, name: string) => {
      if (selector === trigger.selector && name === 'aria-haspopup') {
        return options.declaresDialog === false ? null : 'dialog';
      }
      return null;
    },
    click: async (selector: string) => {
      if (selector === trigger.selector && options.openOnClick) {
        isOpen = true;
      }
    },
    press: async (key: string) => {
      if (key === 'Escape') {
        isOpen = false;
      }
    },
    activeElementWithin: async (selector: string) =>
      (selector === dialog.selector || selector === SEL.dialog) && isOpen && options.focusMovesIntoDialog,
    activeElementIs: async (selector: string) =>
      selector === trigger.selector && !isOpen && options.focusReturnsToTrigger,
  });

  return {
    page: scriptedPage,
    screen: SCREEN,
    config: testConfig(),
  };
}

async function makeMenuContext(options: {
  menuAppearsOnClick: boolean;
  focusMovesIntoMenu: boolean;
}): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  const toggle = element('#menu-toggle');
  const menu = element('#menu');
  let isOpen = false;

  const scriptedPage: Page = Object.assign(page, {
    queryAll: async (selector: string) => {
      if (selector === SEL.menuToggle) {
        return [toggle];
      }
      if (selector === SEL.menu) {
        return isOpen ? [menu] : [];
      }
      return [];
    },
    axAt: async (selector: string) => {
      if (selector === toggle.selector) {
        return {
          name: 'Row actions',
          role: 'button',
          states: { expanded: false, haspopup: 'menu' },
        };
      }
      return null;
    },
    click: async (selector: string) => {
      if (selector === toggle.selector && options.menuAppearsOnClick) {
        isOpen = true;
      }
    },
    press: async (key: string) => {
      if (key === 'Escape') {
        isOpen = false;
      }
    },
    activeElementWithin: async (selector: string) =>
      selector === menu.selector && isOpen && options.focusMovesIntoMenu,
  });

  return {
    page: scriptedPage,
    screen: SCREEN,
    config: testConfig(),
  };
}

describe('rulepack interaction probes', () => {
  it('returns no drafts when dialog opens, focus enters, and focus returns to trigger', async () => {
    const provider = makeRulepackProvider();
    const ctx = await makeDialogContext({
      openOnClick: true,
      focusMovesIntoDialog: true,
      focusReturnsToTrigger: true,
    });

    await expect(provider.run(ctx)).resolves.toEqual([]);
  });

  it('fails closed for open and close lifecycle when opening dialog does not move focus inside', async () => {
    const provider = makeRulepackProvider();
    const ctx = await makeDialogContext({
      openOnClick: true,
      focusMovesIntoDialog: false,
      focusReturnsToTrigger: true,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toHaveLength(2);
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'pf-focus-into-dialog',
          confidence: 'fail',
          severity: 'serious',
          elementPath: '#dialog-trigger',
        }),
        expect.objectContaining({
          rule: 'pf-modal-focus-return',
          confidence: 'fail',
          severity: 'serious',
          elementPath: '#dialog-trigger',
        }),
      ]),
    );
  });

  it('emits pf-modal-focus-return fail when Escape does not return focus to trigger', async () => {
    const provider = makeRulepackProvider();
    const ctx = await makeDialogContext({
      openOnClick: true,
      focusMovesIntoDialog: true,
      focusReturnsToTrigger: false,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'pf-modal-focus-return',
      confidence: 'fail',
      severity: 'serious',
      elementPath: '#dialog-trigger',
    });
  });

  it('emits one unverified draft when a dialog trigger opens nothing', async () => {
    const provider = makeRulepackProvider([]);
    const ctx = await makeDialogContext({
      openOnClick: false,
      focusMovesIntoDialog: false,
      focusReturnsToTrigger: false,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'pf-focus-into-dialog',
      confidence: 'unverified',
      severity: 'serious',
      elementPath: '#dialog-trigger',
    });
  });

  it('stays silent when a plain disclosure control opens something that is not a dialog', async () => {
    // SEL.dialogTrigger matches every aria-expanded plus aria-controls pair, so it picks up
    // accordions and filter toggles as well as modal triggers. Those never promised a dialog,
    // so reporting them would be a claim about the page that the probe cannot support.
    const provider = makeRulepackProvider([]);
    const ctx = await makeDialogContext({
      openOnClick: false,
      focusMovesIntoDialog: false,
      focusReturnsToTrigger: false,
      declaresDialog: false,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toEqual([]);
  });

  it('emits pf-kebab-expanded-state fail when menu opens without moving focus into it', async () => {
    const provider = makeRulepackProvider();
    const ctx = await makeMenuContext({
      menuAppearsOnClick: true,
      focusMovesIntoMenu: false,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'pf-kebab-expanded-state',
      confidence: 'fail',
      severity: 'serious',
      elementPath: '#menu-toggle',
    });
  });

  it('runs dialog probes by default when no extra checks are passed', async () => {
    const provider = makeRulepackProvider();
    const ctx = await makeDialogContext({
      openOnClick: false,
      focusMovesIntoDialog: false,
      focusReturnsToTrigger: false,
    });

    const drafts = draftsOf(await provider.run(ctx));

    expect(drafts.some((draft) => draft.rule === 'pf-focus-into-dialog')).toBe(true);
  });
});
