/**
 * Provider execution seam for accessibility checks.
 * Providers return Draft[] and gaps only. This unit must never decide a verdict.
 * A denied or failing provider becomes an explicit CoverageGap so coverage is honest.
 */
import type {
  Capability,
  CoverageGap,
  Draft,
  Provider,
  ProviderContext,
  ProviderRunResult,
} from '../contracts/index.js';

function deniedCapabilities(provider: Provider, allowed: Set<Capability>): Capability[] {
  return provider.capabilities.filter((capability) => !allowed.has(capability));
}

function capabilityGap(providerId: string, denied: Capability[]): CoverageGap {
  return {
    ref: `provider:${providerId}`,
    state: 'capability-denied',
    reason: `provider ${providerId} denied capability: ${denied.join(', ')}`,
  };
}

function notCoveredGap(providerId: string, message: string): CoverageGap {
  return {
    ref: `provider:${providerId}`,
    state: 'not-covered',
    reason: `provider ${providerId} failed: ${message}`,
  };
}

export async function runProviders(
  providers: Provider[],
  ctx: ProviderContext,
  allowedCapabilities: Capability[],
): Promise<ProviderRunResult> {
  const allowed = new Set(allowedCapabilities);
  const drafts: Draft[] = [];
  const gaps: CoverageGap[] = [];

  // Providers run in order because later interaction checks mutate page state.
  for (const provider of providers) {
    const denied = deniedCapabilities(provider, allowed);
    if (denied.length > 0) {
      gaps.push(capabilityGap(provider.id, denied));
      continue;
    }

    try {
      drafts.push(...(await provider.run(ctx)));
    } catch (err) {
      // Thrown provider work is disclosed as a gap so we never silently pass coverage.
      const message = err instanceof Error ? err.message : String(err);
      gaps.push(notCoveredGap(provider.id, message));
    }
  }

  return { drafts, gaps };
}
