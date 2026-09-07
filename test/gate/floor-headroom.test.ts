/**
 * The evidence floor count is a high-water mark, and these pin what the gate does about it.
 *
 * `usabl baseline` writes the count and `usabl floor prune` lowers it. Nothing else moves it, so
 * between a pay-down and a prune the recorded count stands above what is actually on the screen.
 * That difference is headroom: a new barrier can arrive at a floored identity, take the slot the
 * fixed one left, keep the tally at or under what the floor accepted, and be marked carried. The
 * reviewer drove exactly that and got a verified run with a receipt over a barrier nobody had
 * accepted.
 *
 * The rule these tests hold the gate to is that headroom is DISCLOSED, never blocking. The findings
 * present stay carried, the verdict is untouched, and every surface says the floor is ahead of the
 * application and names the command that re-arms it.
 *
 * Blocking on headroom was built and rejected against the real brownfield floor. Several collapsed
 * identities there count icon buttons in table rows, one entry standing at 15, so the count tracks
 * how many rows a live list happens to render. A blocking rule would have failed unchanged code
 * whenever a list came back one row shorter, and reported a new barrier on the run after the
 * operator pruned. Flapping on dynamic content would make the ratchet unusable on exactly the kind
 * of application it exists for.
 *
 * So the hole is real and stays open until an operator re-arms the floor. These tests pin it as the
 * documented residual rather than leaving it to be rediscovered: a new barrier arriving into
 * headroom is counted as carried, and a barrier swapped in for one fixed in the same change never
 * moves the tally at all. Both are the price of collapsing several barriers onto one identity.
 * Strong element keys and prompt pruning are what shrink it.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Coverage, Draft, EvidenceFloor, GateInput } from '../../src/contracts/index.js';

// Barriers on different nodes that neutralize to one structural identity. This is the collapse the
// count exists to see through: three dialogs at the same neutralized path are one finding.
function dialogAt(nth: number, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'pf-focus-into-dialog', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: `main > div:nth-child(${nth}) > section`,
    elementName: null, role: 'dialog',
    whatUserExperiences: 'Focus stays behind the dialog', why: '', fix: 'Move focus into the dialog',
    evidence: {}, confidence: 'fail', ...over,
  };
}

const covered: Coverage = {
  changedFiles: ['src/ClustersPage.tsx'],
  affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
  unresolvedFiles: [], gaps: [], nothingToCheck: false,
};

const base: Omit<GateInput, 'drafts' | 'floor'> = {
  coverage: covered,
  guardDivergedPaths: [],
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set(['clusters']),
};

const DIALOG_IDENTITY = computeIdentity(dialogAt(1));

/** A floor that accepted `count` barriers at the one dialog identity. */
function dialogFloor(count: number, version: 1 | 2 = 2): EvidenceFloor {
  return {
    version,
    entries: [{
      screenId: 'clusters', layer: 'pf', rule: 'pf-focus-into-dialog',
      elementKey: DIALOG_IDENTITY.elementKey, identityBasis: DIALOG_IDENTITY.identityBasis, count,
    }],
  };
}

describe('stale floor headroom', () => {
  it('discloses without blocking when observed is below the recorded count', () => {
    const out = gate({ ...base, floor: dialogFloor(3), drafts: [dialogAt(1)] });

    // The verdict does not move. This is the whole point: these counts follow live row counts, so
    // a verdict that reacted to them would flap on an unchanged codebase.
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.accessibilityExitCode).toBe(0);
    expect(out.findings[0]!.status).toBe('carried');
    // Not a coverage gap. A gap makes a run not covered by definition, which is the blocking this
    // rule exists to avoid.
    expect(out.floorGaps).toEqual([]);
    expect(out.floorHeadroom).toEqual([
      { screenId: 'clusters', rule: 'pf-focus-into-dialog', recorded: 3, observed: 1 },
    ]);
  });

  it('carries a new barrier that takes a freed slot, and says the floor is ahead', () => {
    // The reviewer's counterexample, and the documented residual rather than an oversight. The
    // floor is a high-water 2 from when two barriers stood here. They were paid down, the floor
    // was never re-armed, and one new barrier has arrived into the difference. By count it is
    // indistinguishable from the debt that was accepted, so it is carried and the run still
    // passes. What usabl can do, and now does, is say on this run that the floor is ahead of the
    // application and that pruning will re-arm it. Until an operator does that, this barrier is
    // recorded as accepted debt. Blocking here was built and rejected: see the file comment.
    const out = gate({ ...base, floor: dialogFloor(2), drafts: [dialogAt(9, { confidence: 'unverified' })] });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('carried');
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorHeadroom).toEqual([
      { screenId: 'clusters', rule: 'pf-focus-into-dialog', recorded: 2, observed: 1 },
    ]);
  });

  it('says the same for a definite failure taking a freed slot', () => {
    // The hole was never about unverified. `hasNewFail` requires new too, so a definite barrier in
    // headroom is carried in exactly the same way and gets exactly the same disclosure.
    const out = gate({ ...base, floor: dialogFloor(2), drafts: [dialogAt(9)] });

    expect(out.findings[0]!.status).toBe('carried');
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorHeadroom).toHaveLength(1);
  });

  it('reports headroom by screen and rule, never by element key', () => {
    // This travels onto the terminal report and into a pull request comment. Screen ids and rule
    // names are usabl's and the operator's own words; an element key carries a neutralized
    // accessible name or element path taken from the page.
    const out = gate({ ...base, floor: dialogFloor(3), drafts: [dialogAt(1)] });
    const entry = out.floorHeadroom[0]!;

    expect(entry.screenId).toBe('clusters');
    expect(entry.rule).toBe('pf-focus-into-dialog');
    expect(JSON.stringify(entry)).not.toContain(DIALOG_IDENTITY.elementKey!);
  });

  it('says nothing once the floor is re-armed to what the run observes', () => {
    // What `usabl floor prune` writes. The notice is transient work with a way to finish it.
    const out = gate({ ...base, floor: dialogFloor(1), drafts: [dialogAt(9)] });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorHeadroom).toEqual([]);
  });

  it('says nothing when a floored identity is fully paid down', () => {
    // Every barrier at the identity is gone, so it is reported `fixed` as before and there is no
    // headroom notice: nothing is standing there for a new barrier to hide among this run.
    const out = gate({ ...base, floor: dialogFloor(2), drafts: [] });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('fixed');
    expect(out.floorHeadroom).toEqual([]);
    expect(out.accessibilityVerdict).toBe('verified');
  });

  it('still blocks when more barriers land on a floored identity than were accepted', () => {
    // The other direction, unchanged. Growth over the recorded count is new debt and gates.
    const out = gate({ ...base, floor: dialogFloor(1), drafts: [dialogAt(1), dialogAt(2)] });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('new');
    expect(out.accessibilityVerdict).toBe('regression');
    expect(out.floorHeadroom).toEqual([]);
  });

  it('verifies the demo state: a floor written from a run, and the identical run against it', () => {
    // Nothing changed since the floor was accepted, which is the common case and the one the
    // brownfield promise is about. Every finding is carried, nothing blocks, nothing is disclosed.
    const drafts = [dialogAt(1), dialogAt(2), dialogAt(3)];
    const out = gate({ ...base, floor: dialogFloor(3), drafts });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.accessibilityExitCode).toBe(0);
    expect(out.findings.every((f) => f.status === 'carried')).toBe(true);
    expect(out.floorGaps).toEqual([]);
    expect(out.floorHeadroom).toEqual([]);
    expect(out.summary).not.toContain('gap');
    expect(out.summary).not.toContain('re-arm');
  });

  it('makes no stale claim about a run with no UI-touching files', () => {
    // Idle measured nothing, so there is no observation to hold the floor against and nothing to
    // disclose. Idle is not a quiet not_covered.
    const idle: Coverage = { ...covered, affected: [], nothingToCheck: true };
    const out = gate({ ...base, coverage: idle, floor: dialogFloor(3), drafts: [] });

    expect(out.accessibilityVerdict).toBeNull();
    expect(out.floorGaps).toEqual([]);
    expect(out.floorHeadroom).toEqual([]);
  });

  it('cannot see a barrier swapped in during the same run, and that is a count limit', () => {
    // The residual, stated rather than hidden. One barrier fixed and one added in a single change
    // leaves the tally at the accepted number, so no comparison of counts can separate this from
    // the untouched floor. Collapsing several barriers onto one identity is what costs the
    // information; a stronger element key is what recovers it, not a better count rule.
    const untouched = gate({ ...base, floor: dialogFloor(2), drafts: [dialogAt(1), dialogAt(2)] });
    const swapped = gate({ ...base, floor: dialogFloor(2), drafts: [dialogAt(1), dialogAt(9)] });

    expect(untouched.accessibilityVerdict).toBe('verified');
    expect(swapped.accessibilityVerdict).toBe('verified');
    expect(swapped.findings[0]!.status).toBe('carried');
  });
});

describe('the summary line carries headroom', () => {
  it('names the entries to re-arm on a verified run, where nothing else would say so', () => {
    const out = gate({ ...base, floor: dialogFloor(3), drafts: [dialogAt(1)] });

    // The clause sits beside the verdict word, so it reads as maintenance under a pass and never
    // as a failure. A verified run is exactly when this needs saying: no barrier, no gap, and the
    // floor quietly ahead of the application.
    expect(out.summary).toBe('verified: nothing blocking, 1 recorded, 1 floor entry to re-arm');
  });

  it('counts the entries, not the barriers behind them', () => {
    const other = dialogAt(1, { rule: 'pf-menu-state', elementPath: 'main > nav' });
    const otherIdentity = computeIdentity(other);
    const floor: EvidenceFloor = {
      version: 2,
      entries: [
        ...dialogFloor(5).entries,
        {
          screenId: 'clusters', layer: 'pf', rule: 'pf-menu-state',
          elementKey: otherIdentity.elementKey, identityBasis: otherIdentity.identityBasis, count: 4,
        },
      ],
    };
    const out = gate({ ...base, floor, drafts: [dialogAt(1), other] });

    expect(out.floorHeadroom).toHaveLength(2);
    expect(out.summary).toContain('2 floor entries to re-arm');
  });

  it('says nothing about re-arming when the floor matches the run', () => {
    const out = gate({ ...base, floor: dialogFloor(1), drafts: [dialogAt(1)] });

    expect(out.summary).toBe('verified: nothing blocking, 1 recorded');
    expect(out.summary).not.toContain('re-arm');
  });
});

describe('the gate is safe through its own exported door', () => {
  it('does not verify a version 1 floor with collapsible entries', () => {
    // The check used to live in run() only, so the exported gate returned verified on a floor the
    // full run path blocked. CI, the overlay and the page helper all reach gate() directly, so the
    // verdict depended on which door the caller came through.
    const out = gate({ ...base, floor: dialogFloor(1, 1), drafts: [dialogAt(1), dialogAt(2), dialogAt(3)] });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.floorGaps.some((g) => g.ref === '.usabl-evidence.json')).toBe(true);
    expect(out.floorGaps[0]!.reason).toContain('usabl baseline');
  });

  it('reaches the same verdict whichever order advisory and deterministic drafts arrive in', () => {
    // A preview draft sharing an identity with a deterministic one used to decide the verdict by
    // arrival order: whichever came first survived the collapse, and a surviving preview draft does
    // not gate. The tally was also mixed, so one advisory draft read as growth over a floor that
    // counted deterministic drafts only.
    const deterministic = dialogAt(1);
    const advisory = dialogAt(2, { evidenceClass: 'preview' });

    const forward = gate({ ...base, floor: dialogFloor(1), drafts: [deterministic, advisory] });
    const reverse = gate({ ...base, floor: dialogFloor(1), drafts: [advisory, deterministic] });

    expect(forward.accessibilityVerdict).toBe(reverse.accessibilityVerdict);
    expect(forward.accessibilityVerdict).toBe('verified');
    expect(forward.findings[0]!.status).toBe(reverse.findings[0]!.status);
    // The survivor is the deterministic draft either way, so a collapse can never disarm a barrier.
    expect(forward.findings[0]!.evidenceClass).toBe('deterministic');
    expect(reverse.findings[0]!.evidenceClass).toBe('deterministic');
  });

  it('counts only deterministic drafts against the floor', () => {
    // The floor is written from deterministic drafts, so the run's tally has to be built the same
    // way. Two advisory drafts beside one accepted deterministic barrier are not growth.
    const out = gate({
      ...base,
      floor: dialogFloor(1),
      drafts: [dialogAt(1), dialogAt(2, { evidenceClass: 'preview' }), dialogAt(3, { evidenceClass: 'model-judgment' })],
    });

    expect(out.findings[0]!.status).toBe('carried');
    expect(out.accessibilityVerdict).toBe('verified');
  });
});
