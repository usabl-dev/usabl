/**
 * Level 1 in real Chromium: every catalog entry runs on its own fixture page, through the core
 * provider stack and the real gate, and the outcome of each is pinned here. A missed entry is pinned
 * as missed. It is a measured fact about the engine, and the catalog and the fixture pages are never
 * changed to make it pass. Gated behind USABL_INTEGRATION=1 because it launches Chromium.
 */
import { describe, expect, it } from 'vitest';
import { SENSITIVITY_CATALOG } from '../../../src/measure/sensitivity/catalog.js';
import { runLevel1 } from '../../../src/measure/sensitivity/level1.js';
import type { EntryMeasurement } from '../../../src/measure/sensitivity/runner.js';

// Two full scans per entry, each with a transcript walk, the keyboard walk, and the PatternFly
// probes, on a machine other browser suites share. One run measured 325 to 446 seconds.
const LEVEL1_BUDGET_MS = 1_200_000;

type Pinned = Pick<EntryMeasurement, 'outcome' | 'rules' | 'reason'>;

const caught = (...rules: string[]): Pinned => ({ outcome: 'caught', rules, reason: null });

const PINNED: Record<string, Pinned> = {
  'button-name-removed': caught('button-name', 'keyboard-walk-unnamed-interactive'),
  'image-alt-removed': caught('image-alt'),
  'field-label-removed': caught('keyboard-walk-unnamed-interactive', 'label'),
  'heading-one-removed': caught('page-has-heading-one'),
  'text-contrast-lowered': caught('color-contrast'),
  // No shipped rule reports a visible control that Tab never reaches.
  'control-out-of-tab-order': { outcome: 'missed', rules: [], reason: 'nothing new gated; no shipped rule claims this defect' },
  'focus-trap': caught('keyboard-walk-trap'),
  'link-name-removed': caught('keyboard-walk-unnamed-interactive', 'link-name'),
  'page-title-removed': caught('document-title'),
  'page-language-removed': caught('html-has-lang'),
  'role-not-a-role': caught('aria-roles'),
  'pf-icon-button-name-removed': caught('button-name', 'keyboard-walk-unnamed-interactive', 'pf-icon-button-name'),
  'menu-toggle-state-removed': caught('pf-kebab-expanded-state'),
  // The menu probe opens a menu with a click, never with Enter.
  'menu-does-not-open-on-enter': { outcome: 'missed', rules: [], reason: 'nothing new gated; expected pf-kebab-expanded-state' },
  'dialog-focus-not-moved-in': caught('pf-focus-into-dialog', 'pf-modal-focus-return'),
  'dialog-focus-not-returned': caught('pf-modal-focus-return'),
  'toast-not-live': caught('pf-toast-live-region'),
  'table-header-scope-removed': caught('pf-table-header-assoc'),
  'row-actions-share-a-name': caught('pf-row-action-name-unique'),
  'repeated-toolbar-label-removed': caught('pf-toolbar-labeled-when-repeated'),
  'flow-live-region-broken': caught('intake:sensitivity-profile-saved'),
  // Voice findings are preview until a person promotes the obligation class.
  'voice-live-region-broken': {
    outcome: 'preview only',
    rules: [
      'intake:sensitivity-profile-saved-voice/missing-announcement',
      'intake:sensitivity-profile-saved-voice/missing-live-announcement',
    ],
    reason:
      'only preview findings were new, and preview never gates: intake:sensitivity-profile-saved-voice/missing-announcement, intake:sensitivity-profile-saved-voice/missing-live-announcement',
  },
  'rhds-button-label-removed': caught('rhds-button-accessible-label'),
  'rhds-cta-link-removed': caught('rhds-cta-link'),
  'rhds-tab-panel-removed': caught('rhds-tabs-paired'),
  'rhds-switch-label-removed': caught('rhds-switch-label'),
  'rhds-skip-link-target-missing': caught('rhds-skip-link-target'),
  'docs-heading-level-skipped': caught('docs-heading-order'),
};

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('Level 1 sensitivity in Chromium', { timeout: LEVEL1_BUDGET_MS }, () => {
  it('pins an outcome for every catalog entry', () => {
    expect(Object.keys(PINNED).sort()).toEqual(SENSITIVITY_CATALOG.map((entry) => entry.id).sort());
  });

  it('measures every catalog entry on its own fixture page, with the pinned outcome', async () => {
    const measurements = await runLevel1({ now: '2026-11-09T00:00:00.000Z' });
    expect(measurements.map((measurement) => [measurement.entry, measurement.screen])).toEqual(
      SENSITIVITY_CATALOG.map((entry) => [entry.id, entry.level1Screen]),
    );
    expect(Object.fromEntries(measurements.map(({ entry, outcome, rules, reason }) => [entry, { outcome, rules, reason }]))).toEqual(PINNED);
  });
});
