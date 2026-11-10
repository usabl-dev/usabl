/**
 * Shared receipt binding helpers for docs artifact generators.
 * This unit defines one source of truth for coverage checks and generatedAt binding.
 * It must never drift into copy-pasted variants, because a forked check could mint fake evidenceRef values.
 */
import type { DocArtifact, Receipt, Result } from '../contracts/index.js';

/**
 * The tree a report is made from: the receipt's tree when the run minted one, because that is the
 * tree its evidence is bound to, and otherwise the tree the caller read when the docs run started.
 * Null when neither is known.
 */
export function reportSourceTree(result: Result, readTree: string | null): string | null {
  const receipt: unknown = result.receipt;
  if (receipt !== null && typeof receipt === 'object') {
    const tree = Reflect.get(receipt, 'sourceTree');
    if (typeof tree === 'string' && tree.length > 0) {
      return tree;
    }
  }
  return readTree;
}

const REGENERATE = 'Run usabl docs again to make it from the current code.';

/**
 * Why a report no longer describes the current code, or null when it does.
 *
 * A report is current only when it records the tree it was made from and that tree is the current
 * one. A report that records no tree is not bound to any code, and a current tree usabl could not
 * read cannot be compared, so both read as stale: silence about the tree is never evidence that
 * the report matches it. A report whose run started on one tree and was bound to another saw a file
 * change during its scan, so it matches no tree and reads as stale against every one.
 */
export function staleReason(artifact: DocArtifact, currentTree: string | null): string | null {
  const made = typeof artifact.sourceTree === 'string' && artifact.sourceTree.length > 0 ? artifact.sourceTree : null;
  if (made === null) {
    return `This report does not record the tree it was made from, so usabl cannot tell whether it matches the current code. ${REGENERATE}`;
  }
  const start = typeof artifact.startTree === 'string' && artifact.startTree.length > 0 ? artifact.startTree : null;
  if (start !== null && start !== made) {
    return `The code changed while this report was made: the run started at tree ${start}, and its receipt is bound to tree ${made}. ${REGENERATE}`;
  }
  if (currentTree === null) {
    return `usabl could not read the current tree, so it cannot tell whether this report, made from tree ${made}, matches the current code. ${REGENERATE}`;
  }
  if (made !== currentTree) {
    return `This report was made from tree ${made}, and the code is now at tree ${currentTree}. ${REGENERATE}`;
  }
  return null;
}

/**
 * The artifacts as read against the current tree: each one made from another tree is marked
 * stale with its reason, and each one made from this tree has any old mark taken off. The input is
 * not changed. This is the one check every place that lists or reads a report uses, so no reader
 * can apply a weaker one.
 */
export function markStale(artifacts: readonly DocArtifact[], currentTree: string | null): DocArtifact[] {
  return artifacts.map((artifact) => {
    const { stale: _stale, staleReason: _reason, ...rest } = artifact;
    const reason = staleReason(artifact, currentTree);
    return reason === null ? rest : { ...rest, stale: true as const, staleReason: reason };
  });
}

export interface EvidenceBinding {
  receipt: Receipt | null;
  covered: boolean;
  generatedAt: string;
  boundToReceipt?: string;
}

export function surfaceWasChecked(result: Result, surface: string): boolean {
  const { receipt } = result;
  return receipt !== null && receipt.coverage.checked.includes(surface);
}

export function buildEvidenceBinding(result: Result, surface: string): EvidenceBinding {
  const { receipt } = result;
  return {
    receipt,
    covered: surfaceWasChecked(result, surface),
    generatedAt: receipt === null ? '' : receipt.mintedAt,
    ...(receipt === null ? {} : { boundToReceipt: receipt.sourceTree }),
  };
}
