import type { ScreenScan } from '../contracts/index.js';
import { neutralizePrintedText } from './summary.js';

/**
 * Integration smoke terminal output projection for one ScreenScan.
 * It is a live CheckRunner egress, so every printed scan string is neutralized.
 * The raw scan object stays unchanged for honest debugging and downstream use.
 */
export function formatIntegrationSmokeEgress(
  scan: ScreenScan,
  sanitize: (text: string) => string = neutralizePrintedText,
): string {
  const lines: string[] = [`stops: ${scan.stops.length} drafts: ${scan.drafts.length} gaps: ${scan.gaps.length}`];
  for (const draft of scan.drafts) {
    lines.push(
      `  [${sanitize(draft.layer)}] ${sanitize(draft.rule)} (${sanitize(draft.confidence)}) @ ${sanitize(draft.elementPath)}`,
    );
  }
  for (const gap of scan.gaps) {
    lines.push(`  GAP ${sanitize(gap.state)}: ${sanitize(gap.reason)}`);
  }
  return lines.join('\n');
}
