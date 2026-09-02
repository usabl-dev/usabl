import { describe, expect, it } from 'vitest';
import type { CheckRunner, CoverageGap, Draft, ScreenScan } from '../../src/contracts/index.js';
import { runMeasurementOnly } from '../../src/measure/fleet-insights.js';

interface FakeCheckRunner extends CheckRunner {
  readonly calls: Array<{ id: string; url: string }>;
  mintVerdictCalled: boolean;
  mintVerdict(): void;
}

function draftFor(screenId: string, rule: string): Draft {
  return {
    rule,
    layer: 'pf',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: 'body > main > button:nth-child(1)',
    elementName: 'Demo button',
    role: 'button',
    whatUserExperiences: 'Keyboard users lose context.',
    why: 'Focus does not return to trigger.',
    fix: 'Move focus back to the trigger on close.',
    evidence: {},
    confidence: 'fail',
  };
}

function scanFor(
  screenId: string,
  url: string,
  options: { drafts?: Draft[]; stops?: number; gaps?: CoverageGap[] } = {},
): ScreenScan {
  return {
    screenId,
    url,
    stops: Array.from({ length: options.stops ?? 0 }, (_, index) => ({
      index,
      elementPath: `body > main > *:nth-child(${index + 1})`,
      announcement: [],
    })),
    drafts: options.drafts ?? [],
    gaps: options.gaps ?? [],
    applicability: [],
  };
}

function makeFakeCheckRunner(scansByInputId: Record<string, ScreenScan>): FakeCheckRunner {
  const calls: Array<{ id: string; url: string }> = [];

  return {
    calls,
    mintVerdictCalled: false,
    mintVerdict() {
      this.mintVerdictCalled = true;
    },
    async scan(screen) {
      calls.push(screen);
      const scan = scansByInputId[screen.id];
      if (scan === undefined) {
        throw new Error(`missing fake scan for ${screen.id}`);
      }
      return scan;
    },
  };
}

describe('runMeasurementOnly', () => {
  it('scans all surfaces in order and aggregates drafts, stops, and gaps', async () => {
    const surfaces = [
      { id: 'overview', url: 'https://fleet.example.test/' },
      { id: 'clusters', url: 'https://fleet.example.test/clusters' },
      { id: 'settings', url: 'https://fleet.example.test/settings' },
    ];

    const clusterGap: CoverageGap = {
      ref: 'https://fleet.example.test/clusters',
      state: 'not-covered',
      reason: 'provider denied live capability',
    };

    const fakeRunner = makeFakeCheckRunner({
      overview: scanFor('overview-screen', surfaces[0]!.url, {
        drafts: [draftFor('overview-screen', 'pf-overview-rule')],
        stops: 2,
      }),
      clusters: scanFor('clusters-screen', surfaces[1]!.url, {
        drafts: [draftFor('clusters-screen', 'pf-cluster-rule-a'), draftFor('clusters-screen', 'pf-cluster-rule-b')],
        stops: 4,
        gaps: [clusterGap],
      }),
      settings: scanFor('settings-screen', surfaces[2]!.url, {
        stops: 1,
      }),
    });

    const report = await runMeasurementOnly(fakeRunner, surfaces);

    expect(fakeRunner.calls).toEqual(surfaces);
    expect(fakeRunner.mintVerdictCalled).toBe(false);
    expect(report.screensAttempted).toBe(3);
    expect(report.screensWithFindings).toBe(2);
    expect(report.totalDrafts).toBe(3);
    expect(report.gaps).toEqual([clusterGap]);
    expect(report.screens).toEqual([
      { id: 'overview-screen', drafts: 1, stops: 2, gaps: 0 },
      { id: 'clusters-screen', drafts: 2, stops: 4, gaps: 1 },
      { id: 'settings-screen', drafts: 0, stops: 1, gaps: 0 },
    ]);
    expect(report.note).toBe('measurement-only: no verdict minted, no receipt written, nothing gated');
  });

  it('reports gaps from scans without turning them into a pass signal', async () => {
    const gap: CoverageGap = {
      ref: 'https://fleet.example.test/workloads',
      state: 'not-covered',
      reason: 'scan failed to open: 302 redirect to login',
    };
    const surfaces = [{ id: 'workloads', url: 'https://fleet.example.test/workloads' }];
    const fakeRunner = makeFakeCheckRunner({
      workloads: scanFor('workloads-screen', surfaces[0]!.url, { gaps: [gap] }),
    });

    const report = await runMeasurementOnly(fakeRunner, surfaces);

    expect(report.screensWithFindings).toBe(0);
    expect(report.totalDrafts).toBe(0);
    expect(report.gaps).toEqual([gap]);
    expect(report.screens).toEqual([{ id: 'workloads-screen', drafts: 0, stops: 0, gaps: 1 }]);
  });
});
