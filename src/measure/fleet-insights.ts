/**
 * Fleet Insights measurement-only harness over CheckRunner scans.
 * This unit reports coverage and draft counts only.
 * It must never call the gate, mint a verdict, or write a receipt.
 */
import type { CheckRunner, CoverageGap, ScreenScan } from '../contracts/index.js';

export interface MeasurementInput {
  id: string;
  url: string;
}

export interface MeasurementReport {
  screensAttempted: number;
  screensWithFindings: number;
  totalDrafts: number;
  gaps: CoverageGap[];
  screens: Array<{ id: string; drafts: number; stops: number; gaps: number }>;
  note: 'measurement-only: no verdict minted, no receipt written, nothing gated';
}

export async function runMeasurementOnly(
  checkRunner: CheckRunner,
  surfaces: MeasurementInput[],
): Promise<MeasurementReport> {
  const scans: ScreenScan[] = [];
  for (const surface of surfaces) {
    scans.push(await checkRunner.scan({ id: surface.id, url: surface.url }));
  }

  return {
    screensAttempted: surfaces.length,
    screensWithFindings: scans.filter((scan) => scan.drafts.length > 0).length,
    totalDrafts: scans.reduce((count, scan) => count + scan.drafts.length, 0),
    gaps: scans.flatMap((scan) => scan.gaps),
    screens: scans.map((scan) => ({
      id: scan.screenId,
      drafts: scan.drafts.length,
      stops: scan.stops.length,
      gaps: scan.gaps.length,
    })),
    note: 'measurement-only: no verdict minted, no receipt written, nothing gated',
  };
}
