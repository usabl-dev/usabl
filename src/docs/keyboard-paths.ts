/**
 * Keyboard path generator for transcript stops per screen.
 * This unit renders tab-order traces into doc artifacts without re-running checks.
 * It must never emit evidence refs for unchecked surfaces or mint timestamps from local time.
 */
import type { DocArtifact, Receipt, Result, TranscriptStop } from '../contracts/index.js';

function isCovered(receipt: Receipt | null, surface: string): receipt is Receipt {
  return receipt !== null && receipt.coverage.checked.includes(surface);
}

function receiptGeneratedAt(receipt: Receipt | null): string {
  // generatedAt follows receipt minting, so docs cannot drift from proof time.
  return receipt === null ? '' : receipt.mintedAt;
}

function stopTokens(stop: TranscriptStop): string {
  return stop.announcement.map((token) => `${token.kind}:${token.text ?? 'null'}`).join(' | ');
}

export function generateKeyboardPaths(result: Result, receipt: Receipt | null): DocArtifact[] {
  return result.screens.map((screen) => {
    const covered = isCovered(receipt, screen.screenId);
    const entries: DocArtifact['entries'] = screen.stops.map((stop, index) => {
      // Evidence ownership is explicit - receipt presence is insufficient without checked coverage.
      const evidenceRef = covered ? `stop:${receipt.sourceTree}:${screen.screenId}:${stop.index}` : undefined;
      return {
        element: `[${index + 1}] ${stop.elementPath}`,
        content: stopTokens(stop),
        status: 'draft',
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      };
    });

    return {
      kind: 'keyboard-paths',
      surface: screen.screenId,
      entries,
      generatedAt: receiptGeneratedAt(receipt),
      ...(receipt === null ? {} : { boundToReceipt: receipt.sourceTree }),
    };
  });
}
