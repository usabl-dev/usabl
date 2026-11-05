import type { AxNode, Draft, HostMarkup, ProfileName, ProviderContext, RuleApplicability } from '../../../src/contracts/index.js';
import { makeFakePage } from '../../../src/deps/fakes.js';
import { makeRhdsRulepackProvider, RHDS_MARKER } from '../../../src/providers/rhds/index.js';
import { applicabilityOf, draftsOf, gapsOf, testConfig } from '../../helpers.js';

export const SCREEN = { id: 'home', url: 'http://127.0.0.1:5173/' };

export interface PagePlan {
  // queryAll results by exact selector. Anything unplanned matches nothing.
  query?: Record<string, string[]>;
  // axAt results by exact selector.
  ax?: Record<string, AxNode | null>;
  // axInShadowRoot results by host selector, then inner selector.
  shadow?: Record<string, Record<string, AxNode | null>>;
  // hostMarkup overrides by exact selector. Any element the query plan returns is otherwise an
  // upgraded element with no attributes and no default-slot text. Anything else matches nothing.
  markup?: Record<string, Partial<HostMarkup> | null>;
  // How many RHDS marker elements the top document holds. Absent means one, so the pack applies.
  markers?: number;
  // How many more sit inside frames or shadow roots, where only countEverywhere sees them.
  markersElsewhere?: number;
}

const BARE: HostMarkup = { defined: true, attributes: {}, defaultSlotText: '' };

export function contextFor(plan: PagePlan, profile?: ProfileName): ProviderContext {
  const known = new Set(Object.values(plan.query ?? {}).flat());
  const page = makeFakePage({
    countEverywhere: async (selector) => (selector === RHDS_MARKER ? (plan.markers ?? 1) + (plan.markersElsewhere ?? 0) : 0),
    queryAll: async (selector) =>
      selector === RHDS_MARKER
        ? Array.from({ length: plan.markers ?? 1 }, (_, index) => ({ selector: `#rhds-marker-${index + 1}` }))
        : (plan.query?.[selector] ?? []).map((s) => ({ selector: s })),
    axAt: async (selector) => plan.ax?.[selector] ?? null,
    axInShadowRoot: async (host, inner) => plan.shadow?.[host]?.[inner] ?? null,
    hostMarkup: async (selector) => {
      if (plan.markup !== undefined && Object.hasOwn(plan.markup, selector)) {
        const markup = plan.markup[selector];
        return markup === null || markup === undefined
          ? null
          : { ...BARE, ...markup, attributes: { ...BARE.attributes, ...markup.attributes } };
      }
      return known.has(selector) ? BARE : null;
    },
  });
  return { page, screen: SCREEN, config: testConfig(), ...(profile !== undefined ? { profile } : {}) };
}

export function ax(name: string | null, role: string): AxNode {
  return { name, role, states: {} };
}

export async function run(
  plan: PagePlan,
  profile?: ProfileName,
): Promise<{ drafts: Draft[]; gaps: unknown[]; applicability: RuleApplicability[] }> {
  const output = await makeRhdsRulepackProvider().run(contextFor(plan, profile));
  return { drafts: draftsOf(output), gaps: gapsOf(output), applicability: applicabilityOf(output) };
}

export function byRule(drafts: Draft[], rule: string): Draft[] {
  return drafts.filter((draft) => draft.rule === rule);
}
