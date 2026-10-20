/**
 * Static toast containment check for PatternFly alerts.
 * This unit must never claim the temporal announcement half. It only proves containment.
 */
import type { AncestorAttributesRead, CoverageGap, Draft, ProviderContext } from '../../contracts/index.js';
import { effectiveLiveValue, type LiveAttributes } from './live-value.js';
import { SEL } from './selectors.js';

const LIVE_ATTRIBUTES = ['aria-live', 'role'] as const;

function toLiveAttributes(record: Record<string, string | null>): LiveAttributes {
  return { ariaLive: record['aria-live'] ?? null, role: record['role'] ?? null };
}

const GAP_REF = 'provider:pf-rulepack/pf-toast-live-region';

function alertGap(selector: string, why: string): CoverageGap {
  return {
    ref: GAP_REF,
    state: 'not-covered',
    reason: `rulepack check pf-toast-live-region could not check alert ${selector}: ${why}`,
  };
}

export interface ToastLiveRegionResult {
  drafts: Draft[];
  // One gap per alert whose live value could not be resolved. Each names the alert, so an alert
  // that could not be checked is never read as one that passed, and it does not hide the others.
  gaps: CoverageGap[];
}

export async function checkPfToastLiveRegion(ctx: ProviderContext): Promise<ToastLiveRegionResult> {
  const allAlerts = await ctx.page.queryAll(SEL.alert);
  const drafts: Draft[] = [];
  const gaps: CoverageGap[] = [];

  for (const alertRef of allAlerts) {
    // A CSS selector can only ask whether some live container sits anywhere above the alert. The
    // live value that applies is the one on the nearest element that sets one, so an off wrapper
    // between a polite region and the alert silences it. That is resolved here, one alert at a time.
    let read: AncestorAttributesRead;
    try {
      read = await ctx.page.ancestorAttributes(alertRef.selector, LIVE_ATTRIBUTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gaps.push(alertGap(alertRef.selector, `its ancestors could not be read: ${message}`));
      continue;
    }
    if (read.kind === 'not-found') {
      // The alert matched a moment ago and cannot be found now. PatternFly toasts close on a timer,
      // so this is expected. Passing it would be a guess, and so would dropping the other alerts.
      gaps.push(
        alertGap(alertRef.selector, 'it could not be found again to read its ancestors, so it may have closed'),
      );
      continue;
    }
    if (read.kind === 'too-deep') {
      gaps.push(
        alertGap(
          alertRef.selector,
          `it has more than ${read.limit} ancestors, so the walk stopped before it reached the root`,
        ),
      );
      continue;
    }
    if (read.chain.length === 0) {
      gaps.push(alertGap(alertRef.selector, 'the page returned no element for it'));
      continue;
    }
    const nodes = read.chain.map(toLiveAttributes);

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

  return { drafts, gaps };
}
