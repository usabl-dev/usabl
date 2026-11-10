/**
 * Provider execution seam for accessibility checks.
 * Providers return drafts, and optionally a record of which rules applied. This unit must never
 * decide a verdict, and it must never read applicability as evidence of anything.
 * A denied or failing provider becomes an explicit CoverageGap so coverage is honest.
 */
import type {
  Capability,
  CoverageGap,
  Draft,
  Provider,
  ProviderContext,
  ProviderNote,
  ProviderOutput,
  ProviderRunResult,
  RuleApplicability,
} from '../contracts/index.js';
import { firstLine } from '../primitives/first-line.js';

/**
 * Thrown by a provider that failed part way and still has preview drafts from the work it finished,
 * such as the silent change rule's drafts for the steps a flow ran before one threw. The failure is
 * a gap as any thrown error is, with the first line of its message only. Only drafts that are not
 * deterministic are kept, so a failed run can never add evidence that decides a verdict.
 */
export class ProviderRunFailed extends Error {
  readonly drafts: Draft[];

  constructor(message: string, drafts: Draft[]) {
    super(message);
    this.name = 'ProviderRunFailed';
    this.drafts = drafts;
  }
}

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

/**
 * Normalizes the two shapes a provider may return. A bare Draft[] says nothing about which rules
 * applied, and nothing is the honest reading of that, so it contributes no applicability.
 *
 * Provider is an exported contract of a published package, so a provider written outside this
 * repository is a real caller the compiler never checked. Drafts, applicability, gaps, and notes are read
 * as the untyped values they really are: anything that is not an array reports nothing, rather than
 * spreading a string into the record one character at a time. This is the only seam that reads a
 * provider return, so it is the only place that needs the check.
 */
function normalizeOutput(output: Draft[] | ProviderOutput): Required<ProviderOutput> {
  if (Array.isArray(output)) {
    return { drafts: output, applicability: [], gaps: [], notes: [] };
  }
  return {
    drafts: Array.isArray(output.drafts) ? output.drafts : [],
    applicability: Array.isArray(output.applicability) ? output.applicability : [],
    gaps: Array.isArray(output.gaps) ? output.gaps : [],
    notes: Array.isArray(output.notes) ? output.notes : [],
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
  const applicability: RuleApplicability[] = [];
  // Disclosures carried beside the drafts. They never become gaps, so they never block a screen.
  const notes: ProviderNote[] = [];

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
      const output = normalizeOutput(await provider.run(ctx));
      drafts.push(...output.drafts);
      applicability.push(...output.applicability);
      notes.push(...output.notes);
      // A provider that isolates its own checks discloses each failed check as a scoped gap.
      // Merge those beside the gaps this seam raises for a whole provider that threw or was denied.
      gaps.push(...output.gaps);
    } catch (err) {
      // Thrown provider work is disclosed as a gap so we never silently pass coverage.
      const message = err instanceof Error ? err.message : String(err);
      // A ProviderRunFailed wraps an error from steps it drove in the browser, whose later lines can
      // be a call log that quotes the element's markup. Its gap keeps only the first line.
      gaps.push(notCoveredGap(provider.id, err instanceof ProviderRunFailed ? firstLine(message) || 'the error had no message' : message));
      if (err instanceof ProviderRunFailed) {
        drafts.push(...err.drafts.filter((draft) => draft.evidenceClass !== 'deterministic'));
      }
    }
  }

  return { drafts, gaps, applicability, notes };
}
