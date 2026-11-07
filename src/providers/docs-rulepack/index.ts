/**
 * Docs rulepack provider for deterministic checks against rendered product documentation.
 * This unit runs only on the docs profile and must never mint a verdict. It returns Drafts
 * so the gate stays the only authority.
 */
import type { Draft, PlannedApplicability, PlannedScreen, Provider, ProviderContext } from '../../contracts/index.js';
import { checkDocsHeadingOrder } from './heading-order.js';

type RulepackCheck = (ctx: ProviderContext) => Promise<Draft[]>;

const STATIC_CHECKS: RulepackCheck[] = [checkDocsHeadingOrder];

// The one rule for where this pack runs. The run below reads it too, so a brief that says the
// pack is off on a screen cannot disagree with what the scan does there.
export function docsRulepackPlan(screen: PlannedScreen): PlannedApplicability {
  return screen.profile === 'docs' ? { applies: true } : { applies: false, why: 'runs on docs pages only' };
}

export function makeDocsRulepackProvider(extraChecks: RulepackCheck[] = []): Provider {
  return {
    id: 'docs-rulepack',
    layer: 'docs-content',
    capabilities: ['live'],
    appliesBeforeScan: docsRulepackPlan,
    async run(ctx: ProviderContext): Promise<Draft[]> {
      // Inverse of the PatternFly rulepack no-op: this pack runs only on docs and stays silent
      // on app and when the profile is absent, so app drafts and gaps are unchanged.
      if (!docsRulepackPlan({ id: ctx.screen.id, profile: ctx.profile ?? 'app' }).applies) {
        return [];
      }

      const drafts: Draft[] = [];
      for (const check of STATIC_CHECKS) {
        drafts.push(...(await check(ctx)));
      }
      for (const check of extraChecks) {
        drafts.push(...(await check(ctx)));
      }

      return drafts;
    },
  };
}
