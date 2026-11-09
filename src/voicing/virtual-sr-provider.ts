/**
 * Virtual screen-reader provider for interaction contracts.
 * This unit runs contract steps and returns Draft[] observations only.
 * It must never mint a verdict and must never self-promote evidence classes.
 */
import type { Draft, InteractionContract, Provider, StepRunner } from '../contracts/index.js';
import { runStructuralTier } from './structural.js';
import { runVoicingTier } from './voicing.js';

export interface VirtualSrProviderOptions {
  // The provider id, which names the provider in a gap. A scan builds one provider per voice
  // requirement and names it intake:<id>, so a denied or failed run names the requirement.
  id?: string;
  // What replaces the voicing/ part of each rule the tiers emit, so a rule names its contract. A
  // finding's identity is its screen, its rule, and its element, so two contracts with a miss on the
  // same control would otherwise share one identity, and one waiver or floor entry written for one
  // contract would cover the other. A scan sets intake:<id>, so the rule reads
  // intake:<id>/missing-name. Left out, the tiers' voicing/ rules are kept.
  rulePrefix?: string;
}

const TIER_RULE_PREFIX = 'voicing/';

function scopeRule(draft: Draft, rulePrefix: string | undefined): Draft {
  if (rulePrefix === undefined || !draft.rule.startsWith(TIER_RULE_PREFIX)) {
    return draft;
  }
  return { ...draft, rule: `${rulePrefix}/${draft.rule.slice(TIER_RULE_PREFIX.length)}` };
}

export function makeVirtualSrProvider(
  contracts: InteractionContract[],
  stepRunner: StepRunner,
  options: VirtualSrProviderOptions = {},
): Provider {
  return {
    id: options.id ?? 'voicing/virtual-sr',
    layer: 'voicing',
    // This provider drives interaction steps on a live page to collect transcript evidence.
    capabilities: ['live'],
    async run(ctx): Promise<Draft[]> {
      const drafts: Draft[] = [];
      const promotedObligations = ctx.config.promotedObligations ?? [];

      for (const contract of contracts) {
        // A contract for another surface is not evidence for this scan.
        if (contract.surfaceId !== ctx.screen.id) {
          continue;
        }

        const stops = await stepRunner.run(ctx.page, contract.steps);
        // Structural checks prove windows are reachable; voicing checks prove wording.
        // Reporting both tiers avoids fake greens from partial evidence.
        drafts.push(...runStructuralTier(contract, stops, ctx.screen.id, promotedObligations));
        // Promotion is read-only runtime input from config. Writing it here would launder
        // advisory evidence into a gate signal without explicit operator policy.
        drafts.push(...runVoicingTier(contract, stops, ctx.screen.id, promotedObligations));
      }

      return drafts.map((draft) => scopeRule(draft, options.rulePrefix));
    },
  };
}
