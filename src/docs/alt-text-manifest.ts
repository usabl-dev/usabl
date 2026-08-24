/**
 * Alt text manifest generator for intake content requirements.
 * This unit projects requirement bundle data into a doc artifact.
 * It must never invent evidence coverage, mutate Result state, or read time from the host clock.
 */
import type { DocArtifact, RequirementBundle, Result } from '../contracts/index.js';
import { buildEvidenceBinding } from './evidence-binding.js';

export function generateAltTextManifest(result: Result, bundle: RequirementBundle, surface: string): DocArtifact {
  // Receipt must come from Result so artifacts cannot be paired with detached proof.
  const binding = buildEvidenceBinding(result, surface);
  const entries: DocArtifact['entries'] = [];

  for (const requirement of bundle.requirements) {
    if (requirement.kind !== 'content' || requirement.surface !== surface) {
      continue;
    }
    if (requirement.assertion.type !== 'content' || requirement.assertion.expectedText === undefined) {
      continue;
    }

    // Surface coverage does not prove this selector's accessible name matched.
    // We bind the artifact to the receipt tree without minting selector-level pass evidence.
    entries.push({
      element: requirement.assertion.selector,
      content: requirement.assertion.expectedText,
      status: requirement.approved ? 'approved' : 'draft',
    });
  }

  return {
    kind: 'alt-text-manifest',
    surface,
    entries,
    generatedAt: binding.generatedAt,
    ...(binding.boundToReceipt === undefined ? {} : { boundToReceipt: binding.boundToReceipt }),
  };
}
