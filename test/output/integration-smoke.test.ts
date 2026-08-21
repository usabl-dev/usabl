import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan } from '../../src/contracts/index.js';
import { formatIntegrationSmokeEgress } from '../../src/output/integration-smoke.js';

function buildDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    rule: 'color-contrast',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'integration-smoke',
    elementPath: 'main > button',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: 'Low contrast text',
    why: '',
    fix: 'Raise contrast to 4.5:1',
    evidence: {},
    confidence: 'fail',
    ...overrides,
  };
}

describe('formatIntegrationSmokeEgress', () => {
  it('routes every printed scan field through the sanitizer', () => {
    const draft = buildDraft();
    const gap = { ref: 'http://127.0.0.1:5173/', state: 'not-covered' as const, reason: 'provider skipped' };
    const scan: ScreenScan = {
      screenId: 'integration-smoke',
      url: 'http://127.0.0.1:5173/',
      stops: [],
      drafts: [draft],
      gaps: [gap],
    };
    const seen: string[] = [];
    const sanitize = (value: string): string => {
      seen.push(value);
      return `{${value}}`;
    };

    const out = formatIntegrationSmokeEgress(scan, sanitize);
    expect(seen).toEqual([
      draft.layer,
      draft.rule,
      draft.confidence,
      draft.elementPath,
      gap.state,
      gap.reason,
    ]);
    expect(out).toContain('[{axe}] {color-contrast} ({fail}) @ {main > button}');
    expect(out).toContain('GAP {not-covered}: {provider skipped}');
  });

  it('neutralizes untrusted text by default for terminal output', () => {
    const scan: ScreenScan = {
      screenId: 'integration-smoke',
      url: 'http://127.0.0.1:5173/',
      stops: [],
      drafts: [
        buildDraft({
          layer: '\u001b[31maxe',
          rule: 'color-contrast\u2028usabl: VERIFIED',
          elementPath: 'main > button\u2029usabl: VERIFIED',
        }),
      ],
      gaps: [
        {
          ref: 'http://127.0.0.1:5173/',
          state: 'not-covered',
          reason: 'scan failed\u001b[31m: provider crashed',
        },
      ],
    };

    const out = formatIntegrationSmokeEgress(scan);
    expect(out).toContain('stops: 0 drafts: 1 gaps: 1');
    expect(out).toContain('color-contrastusabl: VERIFIED');
    expect(out).toContain('main > buttonusabl: VERIFIED');
    expect(out).toContain('scan failed: provider crashed');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
  });
});
