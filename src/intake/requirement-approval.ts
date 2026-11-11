/**
 * A requirement no person has approved yet is shown and never blocks.
 *
 * An import drafts every requirement with approved: false, and a person can write one that way
 * too. Until someone reviews it and sets approved: true, in a change that passes owner review, its
 * checks run on every surface but none of what they report can change the verdict. The gate counts
 * only deterministic evidence, so this unit reports the requirement's own drafts as preview. A gap
 * would change the verdict too, so a check that could not run, or a gap its provider returned, is
 * reported as one preview draft that says the requirement could not be checked and why.
 *
 * Once approved, the provider is returned as it is, so an approved requirement blocks, and a check
 * that could not run is a gap, exactly as before. This unit never decides a verdict and never
 * upgrades evidence: it only lowers an unapproved requirement's drafts to preview.
 */
import type { Draft, Provider, ProviderOutput, Requirement } from '../contracts/index.js';
import { firstLine } from '../primitives/first-line.js';
import { ProviderRunFailed } from '../providers/index.js';

/** The sentence every draft of an unapproved requirement ends with. */
export const NOT_APPROVED_NOTE = 'This requirement is not approved yet, so it is shown and does not block.';

function asPreview(draft: Draft): Draft {
  if (draft.evidenceClass !== 'deterministic') {
    return draft;
  }
  return { ...draft, evidenceClass: 'preview', why: `${draft.why} ${NOT_APPROVED_NOTE}` };
}

// The preview draft that stands in for a gap: the requirement was not checked, and this says why.
function notCheckedDraft(requirement: Requirement, layer: string, reason: string): Draft {
  return {
    rule: `intake:${requirement.id}`,
    layer,
    severity: 'moderate',
    evidenceClass: 'preview',
    screenId: requirement.surface,
    elementPath: 'body',
    elementName: null,
    role: null,
    whatUserExperiences: 'Whether this requirement holds is unknown.',
    why: `The requirement could not be checked: ${reason} ${NOT_APPROVED_NOTE}`,
    fix: 'Check that the requirement still matches the page, then run the check again.',
    evidence: { extra: { notChecked: reason } },
    confidence: 'unverified',
  };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 'the check gave no reason.';
  }
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The provider for a requirement as its approval allows: unchanged when approved, and reporting
 * only preview drafts when not.
 */
export function shownUntilApproved(requirement: Requirement, provider: Provider): Provider {
  if (requirement.approved) {
    return provider;
  }
  return {
    ...provider,
    async run(ctx): Promise<Draft[] | ProviderOutput> {
      let output: Draft[] | ProviderOutput;
      try {
        output = await provider.run(ctx);
      } catch (error) {
        // A browser error's later lines can be a call log that quotes markup, so only the first
        // line is kept, as the provider seam does. Partial drafts that were already not
        // deterministic, such as the silent change rule's, are kept.
        const partial = error instanceof ProviderRunFailed ? error.drafts.filter((d) => d.evidenceClass !== 'deterministic') : [];
        return [...partial, notCheckedDraft(requirement, provider.layer, sentence(firstLine(errorMessage(error))))];
      }
      if (Array.isArray(output)) {
        return output.map(asPreview);
      }
      const drafts = Array.isArray(output.drafts) ? output.drafts.map(asPreview) : [];
      const gaps = Array.isArray(output.gaps) ? output.gaps : [];
      return {
        drafts: [...drafts, ...gaps.map((gap) => notCheckedDraft(requirement, provider.layer, sentence(gap.reason)))],
        ...(output.applicability === undefined ? {} : { applicability: output.applicability }),
        ...(output.notes === undefined ? {} : { notes: output.notes }),
      };
    },
  };
}
