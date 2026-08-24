/**
 * Shared receipt binding helpers for docs artifact generators.
 * This unit defines one source of truth for coverage checks and generatedAt binding.
 * It must never drift into copy-pasted variants, because a forked check could mint fake evidenceRef values.
 */
import type { Receipt, Result } from '../contracts/index.js';

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
