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
  const containedAlerts = await ctx.page.queryAll(`${SEL.liveContainer} ${SEL.alert}`);
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
