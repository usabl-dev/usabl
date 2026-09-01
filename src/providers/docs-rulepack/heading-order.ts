/**
 * Docs heading-order check: flags a rendered heading that skips a level down by more than one.
 * This unit trusts only the AX tree for level, name, and role, and it never mints a verdict.
 *
 * axe-core has a heading-order rule, but it is tagged best-practice, not WCAG. The docs axe
 * profile runs WCAG tags only, so axe's heading-order never fires on docs. This fills that gap
 * with documentation-worded copy.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

export async function checkDocsHeadingOrder(ctx: ProviderContext): Promise<Draft[]> {
  const headings = await ctx.page.queryAll(HEADING_SELECTOR);
  const drafts: Draft[] = [];
  let previousLevel: number | null = null;

  for (const h of headings) {
    const node = await ctx.page.axAt(h.selector);
    // CDP exposes heading depth as the numeric `level` property, copied into states.level.
    // This unifies native <h1>..<h6> and role="heading" aria-level through one honest source.
    // Number.isInteger rejects NaN and non-integers, so a junk level reads as unreadable instead
    // of poisoning previousLevel with NaN, which would silently disable every later comparison.
    const rawLevel = node?.states.level;
    const lvl = Number.isInteger(rawLevel) ? (rawLevel as number) : null;

    if (lvl === null) {
      // Level unreadable: we cannot honestly assert a skip from an unknown level, so we neither
      // flag this heading nor update previousLevel. This is also fail-closed friendly, because a
      // later heading is still compared against the last KNOWN level, so a real skip is still caught.
      continue;
    }

    if (previousLevel !== null && lvl > previousLevel + 1) {
      drafts.push({
        rule: 'docs-heading-order',
        layer: 'docs-content',
        severity: 'moderate',
        evidenceClass: 'deterministic',
        screenId: ctx.screen.id,
        elementPath: h.selector,
        elementName: node?.name ?? null,
        role: node?.role ?? null,
        whatUserExperiences: `A reader who moves through the page by heading level meets a jump from level ${previousLevel} to level ${lvl}, so a section sounds missing and the outline is hard to follow.`,
        why: `Heading levels jump from ${previousLevel} to ${lvl}. Assistive technology users navigate by heading level, and a skipped level hides the structure the document intends.`,
        fix: `Use the next heading level down instead of skipping one. Change this heading to level ${previousLevel + 1}, or add the intermediate heading the structure implies.`,
        evidence: {
          name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
          role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
          extra: { fromLevel: previousLevel, toLevel: lvl },
        },
        confidence: 'fail',
      });
    }

    // Going deeper by exactly one, staying the same, or climbing back up are all fine.
    // Only skipping down by more than one is a violation.
    previousLevel = lvl;
  }

  return drafts;
}
