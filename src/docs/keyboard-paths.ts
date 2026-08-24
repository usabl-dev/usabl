/**
 * Keyboard path generator for transcript stops per screen.
 * This unit renders tab-order traces into doc artifacts without re-running checks.
 * It must never emit evidence refs for unchecked surfaces or mint timestamps from local time.
 */
import type { DocArtifact, Result, TranscriptStop } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import { buildEvidenceBinding } from './evidence-binding.js';

function stopTokens(stop: TranscriptStop): string {
  return stop.announcement
    .map((token) => `${token.kind}:${token.text === null ? 'null' : neutralize(token.text)}`)
    .join(' | ');
}

export function generateKeyboardPaths(result: Result): DocArtifact[] {
  // Receipt must come from Result so docs cannot claim proof for an unverified run.
  return result.screens.map((screen) => {
    const binding = buildEvidenceBinding(result, screen.screenId);
    const entries: DocArtifact['entries'] = screen.stops.map((stop, index) => {
      // Evidence ownership is explicit - receipt presence is insufficient without checked coverage.
      const evidenceRef =
        binding.covered && binding.receipt !== null
          ? `stop:${binding.receipt.sourceTree}:${screen.screenId}:${stop.index}`
          : undefined;
      return {
        element: `[${index + 1}] ${neutralize(stop.elementPath)}`,
        content: stopTokens(stop),
        status: 'draft',
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      };
    });

    return {
      kind: 'keyboard-paths',
      surface: screen.screenId,
      entries,
      generatedAt: binding.generatedAt,
      ...(binding.boundToReceipt === undefined ? {} : { boundToReceipt: binding.boundToReceipt }),
    };
  });
}
