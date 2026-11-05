/**
 * rh-switch naming check. The switch role sits on the host itself, so the host's accessibility node
 * is the control. Markup decides whether a label source exists; the tree decides whether the name
 * is empty.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { cssString, hasText, nameUnavailableDraft, notUpgradedDraft, rhdsDraft } from './draft.js';

const RULE = 'rhds-switch-label';

export const SWITCH_SEL = {
  host: 'rh-switch',
} as const;

/** A label element that points at the given id. */
export function labelFor(id: string): string {
  return `label[for=${cssString(id)}]`;
}

async function hasLabelFor(ctx: ProviderContext, id: string | undefined): Promise<boolean> {
  if (id === undefined || !hasText(id)) {
    return false;
  }
  return (await ctx.page.queryAll(labelFor(id))).length > 0;
}

export async function checkRhdsSwitchLabel(ctx: ProviderContext): Promise<Draft[]> {
  const drafts: Draft[] = [];

  for (const host of await ctx.page.queryAll(SWITCH_SEL.host)) {
    const markup = await ctx.page.hostMarkup(host.selector);
    if (markup === null || hasText(markup.attributes['accessible-label'])) {
      continue;
    }
    if (await hasLabelFor(ctx, markup.attributes['id'])) {
      continue;
    }
    if (!markup.defined) {
      drafts.push(notUpgradedDraft(ctx, RULE, host.selector, 'rh-switch'));
      continue;
    }

    const node = await ctx.page.axAt(host.selector);
    if (node === null) {
      drafts.push(nameUnavailableDraft(ctx, RULE, host.selector, 'rh-switch', 'it has no accessibility node'));
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
        whatUserExperiences: 'Screen reader users hear "switch" with no name, so they do not know what it turns on or off.',
        observed:
          'This rh-switch has no accessible-label and no <label for> pointing at it, and the accessibility tree reports an empty name for it.',
        fix: 'Set accessible-label on the rh-switch, or give it an id and add a <label for> with that id.',
      }),
    );
  }

  return drafts;
}
