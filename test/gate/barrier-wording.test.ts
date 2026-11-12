/**
 * Product rule: text a person reads says "accessibility barrier", never a bare "barrier". These
 * drive the gate into each place it writes its own words about barriers (the summary clause for
 * floored barriers not seen, the two floor gap reasons, and the fix text of a fixed finding) and
 * check the words. The done condition `usabl brief` prints is checked the same way.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { DONE_CONDITIONS } from '../../src/coverage/completeness.js';
import { dialogAt, entryFor, floorOf, gateInputFor, rowButton } from '../history/helpers.js';

/** Every "barrier" or "barriers" that does not follow "accessibility ". */
function bareBarriers(text: string): string[] {
  return text.match(/(?<!accessibility )\bbarriers?\b/gi) ?? [];
}

describe('the gate says accessibility barrier', () => {
  it('in the summary clause for floored barriers it did not see', () => {
    const input = gateInputFor(floorOf([entryFor(dialogAt(1), 2)]), [], ['clusters']);
    // No render evidence, so the absent entry is not claimed fixed and is counted as not seen.
    const { renderEvidence: _unused, ...withoutEvidence } = input;
    const out = gate(withoutEvidence);

    expect(out.summary).toBe('verified: nothing blocking, 2 recorded accessibility barriers not seen, not claimed fixed');
    expect(bareBarriers(out.summary)).toEqual([]);
  });

  it('in the gap for a floor that predates count tracking', () => {
    const out = gate(gateInputFor(floorOf([entryFor(dialogAt(1), 1)], 1), [dialogAt(1)], ['clusters']));
    const reason = out.floorGaps.map((gap) => gap.reason).join(' ');

    expect(reason).toContain('instead of the accessibility barriers observed');
    expect(reason).toContain('Several accessibility barriers can share one of those identities');
    expect(reason).toContain('cannot prove no new accessibility barrier is hiding behind an accepted one');
    expect(bareBarriers(reason)).toEqual([]);
  });

  it('in the gap for a floor that predates row keys', () => {
    const floored = entryFor(dialogAt(1, { screenId: 'jobs' }), 1);
    const out = gate(gateInputFor(floorOf([floored], 2), [rowButton('a')], ['jobs']));
    const reason = out.floorGaps.map((gap) => gap.reason).join(' ');

    expect(reason).toContain('this run found accessibility barriers in table rows');
    expect(reason).toContain('An accessibility barrier fixed in one row and a new one in another row');
    expect(reason).toContain('cannot prove no new accessibility barrier is hiding behind an accepted one');
    expect(bareBarriers(reason)).toEqual([]);
  });

  it('in the fix text of a fixed finding', () => {
    const out = gate(gateInputFor(floorOf([entryFor(dialogAt(1), 1)]), [], ['clusters']));
    const fixed = out.findings.filter((finding) => finding.status === 'fixed');

    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.fix).toBe(
      'Remove this identity from the evidence floor after review so a reintroduced accessibility barrier can gate as new.',
    );
    expect(bareBarriers([fixed[0]!.whatUserExperiences, fixed[0]!.why, fixed[0]!.fix].join(' '))).toEqual([]);
  });

  it('in the done condition usabl brief prints for blocking failures', () => {
    expect(DONE_CONDITIONS.noBlockingFailure).toContain(
      'An accessibility barrier the evidence floor already records, or one a waiver covers, does not block.',
    );
    for (const text of Object.values(DONE_CONDITIONS)) expect(bareBarriers(text)).toEqual([]);
  });
});
