/**
 * rh-cta structure check. Reads markup only: an rh-cta needs an href on the host, or an <a> or a
 * <button> as its first child in the default slot.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { rhdsDraft } from './draft.js';

const RULE = 'rhds-cta-link';

export const CTA_SEL = {
  // A child with a slot attribute is not in the default slot, so it does not count as the link.
  missingTarget: 'rh-cta:not([href]):not(:has(> :is(a, button):not([slot]):first-child))',
} as const;

export async function checkRhdsCtaLink(ctx: ProviderContext): Promise<Draft[]> {
  return (await ctx.page.queryAll(CTA_SEL.missingTarget)).map((cta) =>
    rhdsDraft(ctx, RULE, {
      elementPath: cta.selector,
      severity: 'serious',
      confidence: 'fail',
      whatUserExperiences: 'This call to action is not a link or a button, so keyboard and screen reader users cannot use it.',
      observed: 'This rh-cta has no href, and its first child is not an <a> or a <button>.',
      fix: 'Set href on the rh-cta, or make an <a> or a <button> its first child.',
    }),
  );
}
