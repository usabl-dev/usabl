/**
 * Announcement snippet generator for keyboard walk transcript stops.
 * This unit creates read-only screen artifacts from Result transcript data.
 * It must never claim evidence for unchecked surfaces or stamp wall-clock time.
 */
import type { DocArtifact, Result, TranscriptStop } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import { buildEvidenceBinding } from './evidence-binding.js';

function stopContent(stop: TranscriptStop): string {
  const parts = stop.announcement
    .map((token) => neutralize(token.text?.trim() ?? ''))
    .filter((text) => text.length > 0);
  return parts.join(', ');
}

export function generateAnnouncementSnippets(result: Result): DocArtifact[] {
  // Receipt must come from Result so docs cannot claim proof for an unverified run.
  return result.screens.map((screen) => {
    const binding = buildEvidenceBinding(result, screen.screenId);
    const entries: DocArtifact['entries'] = screen.stops.map((stop) => {
      // We record evidence only when receipt coverage says this surface was checked.
      const evidenceRef =
        binding.covered && binding.receipt !== null
          ? `stop:${binding.receipt.sourceTree}:${screen.screenId}:${stop.index}`
          : undefined;
      return {
        element: neutralize(stop.elementPath),
        content: stopContent(stop),
        status: 'draft',
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      };
    });

    return {
      kind: 'announcement-snippets',
      surface: screen.screenId,
      entries,
      generatedAt: binding.generatedAt,
      ...(binding.boundToReceipt === undefined ? {} : { boundToReceipt: binding.boundToReceipt }),
    };
  });
}
