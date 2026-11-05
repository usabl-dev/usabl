/**
 * rh-skip-link check. Reads markup only: the skip link needs an href or a slotted <a>, and an href
 * fragment must name an element in the document. The href is page text, so it decides the rule and
 * never appears in the draft.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { cssString, rhdsDraft } from './draft.js';

const RULE = 'rhds-skip-link-target';

export const SKIP_LINK_SEL = {
  missingLink: 'rh-skip-link:not([href]):not(:has(> a:not([slot])))',
  fragmentHref: 'rh-skip-link[href^="#"]',
} as const;

/** The element a fragment navigates to: an element with that id, or an anchor with that name. */
export function targetOf(fragment: string): string {
  const value = cssString(fragment);
  return `[id=${value}], a[name=${value}]`;
}

// Fragment navigation looks for the fragment as written and then percent-decoded, so both count.
function fragmentsOf(href: string): string[] {
  const raw = href.slice(1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return [...new Set([raw, decoded])].filter((fragment) => fragment !== '');
}

async function targetExists(ctx: ProviderContext, href: string): Promise<boolean> {
  for (const fragment of fragmentsOf(href)) {
    if ((await ctx.page.queryAll(targetOf(fragment))).length > 0) {
      return true;
    }
  }
  return false;
}

export async function checkRhdsSkipLinkTarget(ctx: ProviderContext): Promise<Draft[]> {
  const drafts: Draft[] = (await ctx.page.queryAll(SKIP_LINK_SEL.missingLink)).map((link) =>
    rhdsDraft(ctx, RULE, {
      elementPath: link.selector,
      severity: 'moderate',
      confidence: 'fail',
      whatUserExperiences: 'This skip link goes nowhere, so keyboard users still have to tab through the navigation.',
      observed: 'This rh-skip-link has no href and no slotted <a>.',
      fix: 'Set href on the rh-skip-link to the id of the main content, for example href="#main-content", or slot an <a> that points there.',
    }),
  );

  for (const link of await ctx.page.queryAll(SKIP_LINK_SEL.fragmentHref)) {
    const markup = await ctx.page.hostMarkup(link.selector);
    if (markup === null) {
      continue;
    }
    if (await targetExists(ctx, markup.attributes['href'] ?? '')) {
      continue;
    }

    drafts.push(
      rhdsDraft(ctx, RULE, {
        elementPath: link.selector,
        severity: 'moderate',
        confidence: 'fail',
        whatUserExperiences: 'This skip link moves focus nowhere, so keyboard users still have to tab through the navigation.',
        observed: 'This rh-skip-link has an href fragment, and no element in the document has that id.',
        fix: 'Point the href at the id of the main content, or add that id to the main content element.',
      }),
    );
  }

  return drafts;
}
