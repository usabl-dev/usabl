/**
 * Applicability for design-system packs. A pack written for one design system runs only on a page
 * that carries that design system's marker. Its selectors and its wording are written for that
 * design system, so on any other page a match would report its rules against markup it never made.
 * This unit never mints a verdict, and it never reads applicability as evidence of anything.
 */
import type { ProviderContext, ProviderOutput, RuleApplicability } from '../contracts/index.js';

/**
 * Whether the page holds at least one element the marker selector matches, in any frame and inside
 * open shadow roots, counted the way Page.countEverywhere counts.
 */
export async function designSystemPresent(ctx: ProviderContext, marker: string): Promise<boolean> {
  return (await ctx.page.countEverywhere(marker)) > 0;
}

/**
 * The output of a pack that does not apply to the page: no drafts, no gaps, and one inapplicable
 * entry per rule with no elements, the way axe reports a rule that matched nothing. A reader can
 * then see that the pack ran on the screen and found none of its design system there. Sorted by
 * rule, so the record does not depend on the order the pack lists its rules in.
 */
export function inapplicableOutput(ctx: ProviderContext, layer: string, rules: readonly string[]): ProviderOutput {
  const applicability: RuleApplicability[] = [...new Set(rules)].sort().map((rule) => ({
    screenId: ctx.screen.id,
    layer,
    rule,
    outcome: 'inapplicable',
    elementCount: 0,
  }));
  return { drafts: [], gaps: [], applicability };
}
