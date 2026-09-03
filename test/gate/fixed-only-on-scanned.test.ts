/**
 * A floored identity may be marked `fixed` only when its screen was actually measured this run.
 *
 * The gate walks the floor and, for every floored identity absent from the drafts, used to emit a
 * `fixed` finding that reads "no longer present on the surface". But a run scans only the affected
 * screens. A floored identity on a screen that was out of scope, or that failed to render, is absent
 * from the drafts because nobody looked, not because the barrier is gone. Marking it `fixed` is a
 * claim about an observation that did not happen, and it reaches every surface that renders findings
 * and, worse, the receipt, which is the proof artifact.
 *
 * The signal that tells "scanned and clean" from "not scanned" is the cleanly-scanned screen set:
 * a screen the run measured with no coverage gap. A cleanly scanned screen with no barrier produces
 * zero drafts, and so does a screen nobody scanned, so absence of drafts alone is ambiguous. The
 * cleanly-scanned set is the only thing that disambiguates them, so the gate takes it as input and
 * emits `fixed` only for a floored identity whose screen is in it.
 */
import { describe, it, expect } from 'vitest';
import { gate, buildFindings } from '../../src/gate/index.js';
import type { Coverage, Draft, EvidenceFloor, Finding, GateInput } from '../../src/contracts/index.js';

const covered: Coverage = {
  changedFiles: ['x'],
  affected: [{ screenId: 'clusters', url: 'u', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

function d(over: Partial<Draft>): Draft {
  return {
    rule: 'color-contrast',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'button',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
    ...over,
  };
}

function floorWith(screenId: string, rule: string): EvidenceFloor {
  return {
    version: 1,
    entries: [
      {
        screenId,
        layer: 'axe',
        rule,
        elementKey: `${screenId}|${rule}|name:save`,
        identityBasis: 'name',
        count: 1,
      },
    ],
  };
}

function gateInput(over: Partial<GateInput>): GateInput {
  return {
    coverage: covered,
    guardDivergedPaths: [],
    drafts: [],
    floor: { version: 1, entries: [] },
    waivers: [],
    now: '2026-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set<string>(),
    ...over,
  };
}

const find = (findings: Finding[], rule: string): Finding[] => findings.filter((f) => f.rule === rule);

describe('fixed is only claimed for a screen that was measured this run', () => {
  it('does not mark a floored identity fixed when its screen was not cleanly scanned', () => {
    // The bug. The barrier is floored on `settings`, which is not in the cleanly-scanned set this
    // run, so its absence from the drafts is unproven. The gate must make no `fixed` claim about it.
    const findings = buildFindings(
      gateInput({
        floor: floorWith('settings', 'gone-rule'),
        drafts: [],
        cleanlyScannedScreens: new Set(['clusters']),
      }),
    );
    expect(find(findings, 'gone-rule')).toEqual([]);
  });

  it('marks a floored identity fixed when its screen was cleanly scanned and the barrier is gone', () => {
    // The case that must still hold. `clusters` was measured cleanly and the floored barrier was not
    // observed, so it is genuinely paid down.
    const findings = buildFindings(
      gateInput({
        floor: floorWith('clusters', 'gone-rule'),
        drafts: [],
        cleanlyScannedScreens: new Set(['clusters']),
      }),
    );
    const fixed = find(findings, 'gone-rule');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.status).toBe('fixed');
  });

  it('emits no fixed finding when no screen was cleanly scanned', () => {
    // The whole-run-unscanned shape at the gate level: an empty cleanly-scanned set means the gate
    // can support no `fixed` claim about any floored identity.
    const findings = buildFindings(
      gateInput({
        floor: floorWith('clusters', 'gone-rule'),
        drafts: [],
        cleanlyScannedScreens: new Set<string>(),
      }),
    );
    expect(find(findings, 'gone-rule')).toEqual([]);
  });

  it('still carries a floored identity that is observed on an unscanned screen list', () => {
    // A floored identity that IS observed stays carried regardless of the cleanly-scanned set. The
    // set only gates the `fixed` claim about an absence, never a present observation.
    const findings = buildFindings(
      gateInput({
        floor: floorWith('clusters', 'color-contrast'),
        drafts: [d({})],
        cleanlyScannedScreens: new Set<string>(),
      }),
    );
    const kept = find(findings, 'color-contrast');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.status).toBe('carried');
  });

  it('through gate(): a fixed claim on an unmeasured screen never reaches the Result findings', () => {
    // The end-to-end shape a surface or receipt would render. The floored identity is on a screen
    // outside the cleanly-scanned set, so no `fixed` finding is in the gate output at all.
    const out = gate(
      gateInput({
        floor: floorWith('settings', 'gone-rule'),
        drafts: [],
        cleanlyScannedScreens: new Set(['clusters']),
      }),
    );
    expect(out.findings.some((f) => f.status === 'fixed')).toBe(false);
    // The clean run over `clusters` with the barrier gone on `settings` unproven is still verified,
    // because a `fixed` that cannot be claimed is simply not emitted, not a block.
    expect(out.verdict).toBe('verified');
  });
});
