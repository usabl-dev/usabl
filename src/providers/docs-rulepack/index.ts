/**
 * Docs rulepack provider for deterministic checks against rendered product documentation.
 * This unit runs only on the docs profile and must never mint a verdict. It returns Drafts
 * so the gate stays the only authority.
 */
import type { Draft, Provider, ProviderContext } from '../../contracts/index.js';
import { checkDocsHeadingOrder } from './heading-order.js';

type RulepackCheck = (ctx: ProviderContext) => Promise<Draft[]>;

const STATIC_CHECKS: RulepackCheck[] = [checkDocsHeadingOrder];

export function makeDocsRulepackProvider(extraChecks: RulepackCheck[] = []): Provider {
  return {
    id: 'docs-rulepack',
    layer: 'docs-content',
    capabilities: ['live'],
    async run(ctx: ProviderContext): Promise<Draft[]> {
      // Inverse of the PatternFly rulepack no-op: this pack runs only on docs and stays silent
      // on app and when the profile is absent, so app drafts and gaps are unchanged.
      if ((ctx.profile ?? 'app') !== 'docs') {
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
