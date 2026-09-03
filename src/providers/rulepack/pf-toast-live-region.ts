/**
 * Static toast containment check for PatternFly alerts.
 * This unit must never claim the temporal announcement half. It only proves containment.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

export async function checkPfToastLiveRegion(ctx: ProviderContext): Promise<Draft[]> {
  const allAlerts = await ctx.page.queryAll(SEL.alert);
  if (allAlerts.length === 0) {
    return [];
  }

  // Set difference keeps this honest: only alerts outside any live container fail.
  //
  // The contained query pairs the descendant combinator with each live-container term
  // separately. SEL.liveContainer is a comma group, and a comma binds looser than a descendant
  // combinator, so `${SEL.liveContainer} ${SEL.alert}` would attach the alert only to the last
  // term and read the other containers as bare matches. That left every real alert outside the
  // contained set, so a contained alert was reported as loose. Distributing the descendant across
  // each term matches an alert that sits inside any live container.
  const containedQuery = SEL.liveContainer
    .split(',')
    .map((container) => `${container.trim()} ${SEL.alert}`)
    .join(', ');
  const containedAlerts = await ctx.page.queryAll(containedQuery);
  const containedSelectors = new Set(containedAlerts.map((candidate) => candidate.selector));

  const drafts: Draft[] = [];
  for (const alertRef of allAlerts) {
    if (containedSelectors.has(alertRef.selector)) {
      continue;
    }

    const node = await ctx.page.axAt(alertRef.selector);
    drafts.push({
      rule: 'pf-toast-live-region',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: alertRef.selector,
      elementName: node?.name ?? null,
      role: node?.role ?? null,
      whatUserExperiences: 'A toast appears but assistive technology may not announce it.',
      why: 'The alert is outside every aria-live or status container.',
      fix: 'Render the alert inside a live region container that remains mounted.',
      evidence: {
        name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
        role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
      },
      confidence: 'fail',
    });
  }

  return drafts;
}
