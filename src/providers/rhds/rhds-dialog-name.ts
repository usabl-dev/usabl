/**
 * rh-dialog naming check. Markup decides whether a name source exists: an accessible-label, an h2 to
 * h6 heading in the header or default slot, or a trigger element with text, which the component
 * uses as its fallback name. Only when there is none is the accessibility tree asked. A closed
 * dialog is absent from the tree, which is unknown rather than an empty name.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { cssString, hasText, nameUnavailableDraft, notUpgradedDraft, rhdsDraft } from './draft.js';

const RULE = 'rhds-dialog-name';
const HEADING = ':is(h2, h3, h4, h5, h6)';

export const DIALOG_SEL = {
  host: 'rh-dialog',
  // The native dialog rh-dialog renders in its open shadow root.
  inner: 'dialog',
} as const;

/** The trigger element the trigger attribute names, by id in the document. */
export function triggerOf(id: string): string {
  return `[id=${cssString(id)}]`;
}

/** Headings in the header slot, or anywhere inside content assigned to the default slot. */
export function headingsIn(host: string): string {
  return [
    `${host} > ${HEADING}[slot="header"]`,
    `${host} > [slot="header"] ${HEADING}`,
    `${host} > ${HEADING}:not([slot])`,
    `${host} > :not([slot]) ${HEADING}`,
  ].join(', ');
}

async function triggerHasText(ctx: ProviderContext, id: string | undefined): Promise<boolean> {
  if (id === undefined || !hasText(id)) {
    return false;
  }
  const trigger = await ctx.page.hostMarkup(triggerOf(id));
  return trigger !== null && hasText(trigger.defaultSlotText);
}

export async function checkRhdsDialogName(ctx: ProviderContext): Promise<Draft[]> {
  const drafts: Draft[] = [];

  for (const host of await ctx.page.queryAll(DIALOG_SEL.host)) {
    const markup = await ctx.page.hostMarkup(host.selector);
    if (markup === null || hasText(markup.attributes['accessible-label'])) {
      continue;
    }
    if ((await ctx.page.queryAll(headingsIn(host.selector))).length > 0) {
      continue;
    }
    if (await triggerHasText(ctx, markup.attributes['trigger'])) {
      continue;
    }
    if (!markup.defined) {
      drafts.push(notUpgradedDraft(ctx, RULE, host.selector, 'rh-dialog'));
      continue;
    }

    const node = await ctx.page.axInShadowRoot(host.selector, DIALOG_SEL.inner);
    if (node === null) {
      drafts.push(nameUnavailableDraft(ctx, RULE, host.selector, 'rh-dialog', 'it is closed or hidden, so it is not in the accessibility tree'));
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
        whatUserExperiences: 'Screen reader users hear "dialog" with no name, so they do not know what it is for.',
        observed:
          'This rh-dialog has no accessible-label, no h2 to h6 heading in its header or default slot, and no trigger with text, and the accessibility tree reports an empty name for it.',
        fix: 'Add an h2 to h6 heading with slot="header", or set accessible-label on the rh-dialog.',
      }),
    );
  }

  return drafts;
}
