/**
 * Announcement snippet generator for keyboard walk transcript stops.
 * This unit creates read-only screen artifacts from Result transcript data.
 * It must never claim evidence for unchecked surfaces or stamp wall-clock time.
 */
import type { DocArtifact, Receipt, Result, TranscriptStop } from '../contracts/index.js';

function isCovered(receipt: Receipt | null, surface: string): receipt is Receipt {
  return receipt !== null && receipt.coverage.checked.includes(surface);
}

function receiptGeneratedAt(receipt: Receipt | null): string {
  // generatedAt mirrors receipt mint time so reruns stay deterministic.
  return receipt === null ? '' : receipt.mintedAt;
}

function stopContent(stop: TranscriptStop): string {
  const parts = stop.announcement
    .map((token) => token.text?.trim() ?? '')
    .filter((text) => text.length > 0);
  return parts.join(', ');
}

export function generateAnnouncementSnippets(result: Result, receipt: Receipt | null): DocArtifact[] {
  return result.screens.map((screen) => {
    const covered = isCovered(receipt, screen.screenId);
    const entries: DocArtifact['entries'] = screen.stops.map((stop) => {
      // We record evidence only when receipt coverage says this surface was checked.
      const evidenceRef = covered ? `stop:${receipt.sourceTree}:${screen.screenId}:${stop.index}` : undefined;
      return {
        element: stop.elementPath,
        content: stopContent(stop),
        status: 'draft',
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      };
    });

    return {
      kind: 'announcement-snippets',
      surface: screen.screenId,
      entries,
      generatedAt: receiptGeneratedAt(receipt),
      ...(receipt === null ? {} : { boundToReceipt: receipt.sourceTree }),
    };
  });
}
