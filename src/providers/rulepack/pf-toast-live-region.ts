/**
 * Static toast containment check for PatternFly alerts.
 * This unit must never claim the temporal announcement half. It only proves containment.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { effectiveLiveValue, type LiveAttributes } from './live-value.js';
import { SEL } from './selectors.js';

const LIVE_ATTRIBUTES = ['aria-live', 'role'] as const;

function toLiveAttributes(record: Record<string, string | null>): LiveAttributes {
  return { ariaLive: record['aria-live'] ?? null, role: record['role'] ?? null };
}

export async function checkPfToastLiveRegion(ctx: ProviderContext): Promise<Draft[]> {
  const allAlerts = await ctx.page.queryAll(SEL.alert);
  if (allAlerts.length === 0) {
    return [];
  }

  const drafts: Draft[] = [];
  for (const alertRef of allAlerts) {
    // A CSS selector can only ask whether some live container sits anywhere above the alert. The
    // live value that applies is the one on the nearest element that sets one, so an off wrapper
    // between a polite region and the alert silences it. That is resolved here, one alert at a time.
    const chain = await ctx.page.ancestorAttributes(alertRef.selector, LIVE_ATTRIBUTES);
    if (chain === null || chain.length === 0) {
      // The alert matched a moment ago and cannot be found now. Passing it would be a guess, so the
      // throw becomes a disclosed gap for this check.
      throw new Error(`could not read the ancestors of alert ${alertRef.selector}`);
    }
    const nodes = chain.map(toLiveAttributes);

    // Two conditions, both required. The container above the alert must be live, because a live
    // value the alert carries itself does not make a region that exists before the alert mounts.
    // And the alert's own content must be live, because an aria-live="off" on the alert itself
    // silences it even inside a live container.
    const containerIsLive = effectiveLiveValue(nodes.slice(1)) !== 'off';
    const contentIsLive = effectiveLiveValue(nodes) !== 'off';
    if (containerIsLive && contentIsLive) {
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
      why: 'No polite or assertive live region reaches the alert.',
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
