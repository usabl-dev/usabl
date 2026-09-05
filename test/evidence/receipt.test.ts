import { describe, it, expect } from 'vitest';
import { mintReceipt, summarizeApplicability } from '../../src/evidence/receipt.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { canonicalHash } from '../../src/primitives/canonical.js';
import type { RuleApplicability, RuleOutcome, ScreenScan, UsablConfig } from '../../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173', uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'x', wideBlastGlobs: [] }, surfaces: [],
  guardedPaths: ['usabl.config.json', 'src/gate'],
};

function applic(rule: string, outcome: RuleOutcome, elementCount: number): RuleApplicability {
  return { screenId: 'x', layer: 'axe', rule, outcome, elementCount };
}

function screen(screenId: string, applicability: RuleApplicability[]): ScreenScan {
  return {
    screenId,
    url: `/${screenId}`,
    stops: [],
    drafts: [],
    gaps: [],
    applicability,
    reachedSelectorPresent: null,
  };
}

describe('mintReceipt', () => {
  it('binds source tree, policy hash, and runner version', async () => {
    const deps = makeFakeDeps({
      now: '2026-08-19T12:00:00.000Z', writeTree: 'tree-abc', runnerVersion: '0.0.0-test',
      headBlobs: { 'usabl.config.json': 'blob-1', 'src/gate': 'blob-2' },
    });
    const receipt = await mintReceipt(deps, config, {
      surfaces: ['cli'], checked: ['clusters'], notCovered: [], applicability: [],
      findingsSummary: { new: 0, carried: 1, fixed: 0, unverified: 0 }, activeWaivers: 0,
    });
    expect(receipt.verdict).toBe('verified');
    expect(receipt.sourceTree).toBe('tree-abc');
    expect(receipt.runnerVersion).toBe('0.0.0-test');
    expect(receipt.mintedAt).toBe('2026-08-19T12:00:00.000Z');
    expect(receipt.policyHash).toBe(canonicalHash([['src/gate', 'blob-2'], ['usabl.config.json', 'blob-1']]));
    expect(receipt.baseRevision).toBeNull();
  });

  it('records the applicability summary it was given, so a receipt states what was checked', async () => {
    const deps = makeFakeDeps({ now: '2026-08-19T12:00:00.000Z', writeTree: 'tree-abc', runnerVersion: '0.0.0-test' });
    const applicability = [{ screenId: 'clusters', applied: 40, abstained: 3 }];
    const receipt = await mintReceipt(deps, config, {
      surfaces: ['cli'], checked: ['clusters'], notCovered: [], applicability,
      findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 }, activeWaivers: 0,
    });
    expect(receipt.applicability).toEqual([{ screenId: 'clusters', applied: 40, abstained: 3 }]);
  });
});

describe('summarizeApplicability', () => {
  it('counts rules that examined an element as applied and rules that matched nothing as abstained', () => {
    // The distinction this whole record exists for: a rule that ran and found nothing (passed)
    // versus a rule that never applied (inapplicable, zero candidates). Only inapplicable is
    // abstained; failed, incomplete, and passed all examined at least one element.
    const summary = summarizeApplicability([
      screen('clusters', [
        applic('color-contrast', 'passed', 40),
        applic('image-alt', 'failed', 2),
        applic('aria-required-children', 'incomplete', 1),
        applic('pf-modal-focus-return', 'inapplicable', 0),
        applic('pf-focus-into-dialog', 'inapplicable', 0),
      ]),
    ]);
    expect(summary).toEqual([{ screenId: 'clusters', applied: 3, abstained: 2 }]);
  });

  it('omits a screen with no applicability data rather than record it as 0/0 noise', () => {
    // An unseen screen is stripped of applicability upstream, so it carries no examined/abstained
    // claim. It must not appear in the receipt as if it had been checked and found empty.
    const summary = summarizeApplicability([
      screen('clusters', [applic('image-alt', 'passed', 5)]),
      screen('unseen', []),
    ]);
    expect(summary.map((s) => s.screenId)).toEqual(['clusters']);
  });

  it('sorts by screenId so the same inputs produce the same receipt bytes', () => {
    const summary = summarizeApplicability([
      screen('zeta', [applic('r', 'passed', 1)]),
      screen('alpha', [applic('r', 'passed', 1)]),
    ]);
    expect(summary.map((s) => s.screenId)).toEqual(['alpha', 'zeta']);
  });
});
