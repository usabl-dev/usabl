/**
 * rh-button naming check. Markup decides whether a name source exists: an accessible-label, or
 * text in the default slot. Only when there is none is the accessibility tree of the native button
 * inside the component asked whether its name is empty. The tree decides, never the markup alone.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { hasText, nameUnavailableDraft, notUpgradedDraft, rhdsDraft } from './draft.js';

const RULE = 'rhds-button-accessible-label';

export const BUTTON_SEL = {
  host: 'rh-button',
  // The native button rh-button renders in its open shadow root.
  inner: 'button',
} as const;

export async function checkRhdsButtonAccessibleLabel(ctx: ProviderContext): Promise<Draft[]> {
  const drafts: Draft[] = [];

  for (const host of await ctx.page.queryAll(BUTTON_SEL.host)) {
    const markup = await ctx.page.hostMarkup(host.selector);
    if (markup === null) {
      continue;
    }
    // Markup with a name source is what the quote asks for. That holds even where the tree cannot
    // be read, such as a labelled button inside a closed dialog.
    if (hasText(markup.attributes['accessible-label']) || hasText(markup.defaultSlotText)) {
      continue;
    }
    if (!markup.defined) {
      drafts.push(notUpgradedDraft(ctx, RULE, host.selector, 'rh-button'));
      continue;
    }

    const node = await ctx.page.axInShadowRoot(host.selector, BUTTON_SEL.inner);
    if (node === null) {
      drafts.push(nameUnavailableDraft(ctx, RULE, host.selector, 'rh-button', 'its inner button has no accessibility node'));
      continue;
    }
    if (hasText(node.name)) {
      continue;
    }

    drafts.push(
      rhdsDraft(ctx, RULE, {
        elementPath: host.selector,
        node,
        severity: 'serious',
        confidence: 'fail',
        whatUserExperiences: 'Screen reader users hear "button" with no name, so they cannot tell what it does.',
        observed:
          'This rh-button has no accessible-label and no text in its default slot, and the accessibility tree reports an empty name for its inner button.',
        fix: 'Set accessible-label on the rh-button, for example accessible-label="Close", or put text in its default slot.',
      }),
    );
  }

  return drafts;
}
