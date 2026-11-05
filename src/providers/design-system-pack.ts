/**
 * Applicability for design-system packs. A pack written for one design system runs only on a page
 * whose top document carries that design system's marker. Its selectors and its wording are written
 * for that design system, so on any other page a match would report its rules against markup it
 * never made. This unit never mints a verdict, and it never reads applicability as evidence.
 */
import type { ProviderContext, ProviderNote, ProviderOutput, RuleApplicability } from '../contracts/index.js';

export interface DesignSystemPack {
  // The provider id, used in the note ref.
  id: string;
  layer: string;
  // The design system's name as a reader knows it, for the note reason.
  name: string;
  marker: string;
  rules: readonly string[];
}

/**
 * The output of a pack that does not apply to the page, or null when it applies.
 *
 * The pack applies when the top document holds an element the marker matches, read with queryAll,
 * the same read the rules use. A read that throws reaches the provider runner, which discloses it.
 * When the top document holds none, the pack reports each rule as inapplicable with no elements, the
 * way axe reports a rule that matched nothing. If marker elements sit inside frames or open shadow
 * roots, which the rules do not read, it also returns one note that counts them, so a reader knows
 * the pack's rules did not check them. A note is disclosure only: it is not a gap, the gate never
 * reads it, and it never blocks the screen. axe and the keyboard walk still read those frames and
 * open shadow roots. countEverywhere adds nothing for a frame it cannot read, so it only ever adds
 * the note and never decides that the pack applies.
 */
export async function packNotApplicable(ctx: ProviderContext, pack: DesignSystemPack): Promise<ProviderOutput | null> {
  if ((await ctx.page.queryAll(pack.marker)).length > 0) {
    return null;
  }
  const output = inapplicableOutput(ctx, pack.layer, pack.rules);
  const elsewhere = await ctx.page.countEverywhere(pack.marker);
  if (elsewhere > 0) {
    output.notes = [outOfDocumentNote(pack, elsewhere)];
  }
  return output;
}

function outOfDocumentNote(pack: DesignSystemPack, count: number): ProviderNote {
  return {
    ref: `provider:${pack.id}/out-of-document`,
    reason: `${count} ${pack.name} element(s) sit inside frames or shadow roots, which the ${pack.name} rulepack does not read, so the ${pack.name} rules did not check them.`,
  };
}

/**
 * One inapplicable entry per rule with no elements, sorted by rule, so the record does not depend
 * on the order the pack lists its rules in. A reader can see that the pack ran on the screen.
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
