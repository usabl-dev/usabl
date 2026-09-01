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

function dirtyPageGap(providerId: string, mutatorId: string): CoverageGap {
  // `skipped` says we chose not to run it, which is a different fact from a provider that failed.
  return {
    ref: `provider:${providerId}`,
    state: 'skipped',
    reason: `provider ${providerId} needs the page as loaded, but provider ${mutatorId} already changed page state`,
  };
}

/**
 * Providers that change the page run last, so a provider reading the loaded page still sees it.
 * Each group keeps the caller's order, because a provider list is also a stated running order.
 */
function orderByPageEffect(providers: Provider[]): Provider[] {
  return [
    ...providers.filter((provider) => provider.mutatesPageState !== true),
    ...providers.filter((provider) => provider.mutatesPageState === true),
  ];
}

export async function runProviders(
  providers: Provider[],
  ctx: ProviderContext,
  allowedCapabilities: Capability[],
): Promise<ProviderRunResult> {
  const allowed = new Set(allowedCapabilities);
  const drafts: Draft[] = [];
  const gaps: CoverageGap[] = [];

  let mutatedBy: string | null = null;

  for (const provider of orderByPageEffect(providers)) {
    const denied = deniedCapabilities(provider, allowed);
    if (denied.length > 0) {
      gaps.push(capabilityGap(provider.id, denied));
      continue;
    }

    if (provider.requiresPristinePage === true && mutatedBy !== null) {
      // Running it on a changed page would return little or nothing and look like a clean layer,
      // so the gap is the honest outcome. Ordering keeps this off the default path.
      gaps.push(dirtyPageGap(provider.id, mutatedBy));
      continue;
    }

    // Recorded before the run because a provider that throws mid-probe has already clicked.
    if (provider.mutatesPageState === true) {
      mutatedBy ??= provider.id;
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
