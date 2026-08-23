/**
 * Virtual screen-reader provider for interaction contracts.
 * This unit runs contract steps and returns Draft[] observations only.
 * It must never mint a verdict and must never self-promote evidence classes.
 */
import type { Draft, InteractionContract, Provider, StepRunner } from '../contracts/index.js';
import { runStructuralTier } from './structural.js';
import { runVoicingTier } from './voicing.js';

export function makeVirtualSrProvider(contracts: InteractionContract[], stepRunner: StepRunner): Provider {
  return {
    id: 'voicing/virtual-sr',
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
        drafts.push(...runStructuralTier(contract, stops, ctx.screen.id));
        // Promotion is read-only runtime input from config. Writing it here would launder
        // advisory evidence into a gate signal without explicit operator policy.
        drafts.push(...runVoicingTier(contract, stops, ctx.screen.id, promotedObligations));
      }

      return drafts;
    },
  };
}
