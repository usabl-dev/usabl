/**
 * rh-tabs pairing check. Reads markup only. Each rh-tabs is counted on its own: the tabs in its tab
 * slot against the panels in its default slot. Direct children only, so a tab set nested in a panel
 * is counted as its own set and never added to its parent's.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { rhdsDraft } from './draft.js';

const RULE = 'rhds-tabs-paired';

export const TABS_SEL = {
  host: 'rh-tabs',
} as const;

export function tabsIn(host: string): string {
  return `${host} > rh-tab[slot="tab"]`;
}

export function panelsIn(host: string): string {
  // slot="" is the default slot, the same as no slot attribute.
  return `${host} > rh-tab-panel:is(:not([slot]), [slot=""])`;
}

export async function checkRhdsTabsPaired(ctx: ProviderContext): Promise<Draft[]> {
  const drafts: Draft[] = [];
  for (const tabs of await ctx.page.queryAll(TABS_SEL.host)) {
    const tabCount = (await ctx.page.queryAll(tabsIn(tabs.selector))).length;
    const panelCount = (await ctx.page.queryAll(panelsIn(tabs.selector))).length;
    if (tabCount === panelCount) {
      continue;
    }

    drafts.push(
      rhdsDraft(ctx, RULE, {
        elementPath: tabs.selector,
        severity: 'serious',
        confidence: 'fail',
        whatUserExperiences: 'Some tabs open no panel, or some panels have no tab, so users cannot reach all of the content.',
        observed: `This rh-tabs has ${tabCount} rh-tab in its tab slot and ${panelCount} rh-tab-panel in its default slot.`,
        fix: 'Give every rh-tab slot="tab" and one matching rh-tab-panel, in the same order.',
      }),
    );
  }
  return drafts;
}
