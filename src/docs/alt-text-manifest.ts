/**
 * Alt text manifest generator for intake content requirements.
 * This unit projects requirement bundle data into a doc artifact.
 * It must never invent evidence coverage, mutate Result state, or read time from the host clock.
 */
import type { DocArtifact, Receipt, RequirementBundle, Result } from '../contracts/index.js';

function isCovered(receipt: Receipt | null, surface: string): receipt is Receipt {
  return receipt !== null && receipt.coverage.checked.includes(surface);
}

function receiptGeneratedAt(receipt: Receipt | null): string {
  // Clock discipline keeps artifact timestamps replayable with the same receipt.
  return receipt === null ? '' : receipt.mintedAt;
}

export function generateAltTextManifest(
  _result: Result,
  receipt: Receipt | null,
  bundle: RequirementBundle,
  surface: string,
): DocArtifact {
  const covered = isCovered(receipt, surface);
  const entries: DocArtifact['entries'] = [];

  for (const requirement of bundle.requirements) {
    if (requirement.kind !== 'content' || requirement.surface !== surface) {
      continue;
    }
    if (requirement.assertion.type !== 'content' || requirement.assertion.expectedText === undefined) {
      continue;
    }

    // Evidence references appear only for covered surfaces, never by receipt presence alone.
    const evidenceRef = covered
      ? `receipt:${receipt.sourceTree}:${surface}:${requirement.assertion.selector}`
      : undefined;
    entries.push({
      element: requirement.assertion.selector,
      content: requirement.assertion.expectedText,
      status: requirement.approved ? 'approved' : 'draft',
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    });
  }

  return {
    kind: 'alt-text-manifest',
    surface,
    entries,
    generatedAt: receiptGeneratedAt(receipt),
    ...(receipt === null ? {} : { boundToReceipt: receipt.sourceTree }),
  };
}
