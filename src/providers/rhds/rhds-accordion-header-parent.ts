/**
 * rh-accordion-header placement check. Reads the authored parent in the document only.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { rhdsDraft } from './draft.js';

const RULE = 'rhds-accordion-header-parent';

export const ACCORDION_SEL = {
  misplacedHeader: 'rh-accordion-header:not(rh-accordion > rh-accordion-header)',
} as const;

export async function checkRhdsAccordionHeaderParent(ctx: ProviderContext): Promise<Draft[]> {
  return (await ctx.page.queryAll(ACCORDION_SEL.misplacedHeader)).map((header) =>
    rhdsDraft(ctx, RULE, {
      elementPath: header.selector,
      severity: 'moderate',
      confidence: 'fail',
      whatUserExperiences: 'This accordion header is outside an accordion, so its expand and collapse behavior may not work or be announced.',
      observed: 'The parent element of this rh-accordion-header is not rh-accordion.',
      fix: 'Move the rh-accordion-header, with its rh-accordion-panel, directly inside an rh-accordion.',
    }),
  );
}
