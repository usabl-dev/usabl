/**
 * The gate must reach the same answer whatever order the drafts arrived in.
 *
 * Providers emit drafts in whatever order they walked the page, and several drafts can neutralize
 * onto one identity and collapse into a single finding. Whichever draft survives that collapse
 * supplies the confidence, the severity and the prose, and confidence is a verdict input. So a
 * collapse that depended on arrival order made the verdict depend on it too: one `fail` draft and
 * one `unverified` draft at one identity produced `regression` in one order and `not_covered` in
 * the other, from the same page.
 *
 * These tests assert more than the verdict. They serialize the whole findings array canonically and
 * require it to be byte identical across every permutation, because a stable verdict over unstable
 * finding bytes still means the terminal, the pull request comment and the overlay can render two
 * different reports from one page, and a receipt can be minted over either.
 *
 * Permutations are exhaustive rather than sampled: 2 drafts is 2 orders, 3 is 6, and the
 * two-identity case is 24. Small enough to enumerate, and enumerating is the only way to be sure
 * there is no pair the comparator leaves to arrival order.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { canonicalize } from '../../src/primitives/canonical.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Coverage, Draft, EvidenceFloor, GateInput } from '../../src/contracts/index.js';

/** Every ordering of a list. Exhaustive, so no ordering the comparator mishandles can hide. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

// Drafts on different nodes that neutralize to one structural identity, which is the collapse the
// representative is chosen from. `nth` moves the element path only.
function dialog(nth: number, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'pf-focus-into-dialog', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: `main > div:nth-child(${nth}) > section`,
    elementName: null, role: 'dialog',
    whatUserExperiences: 'Focus stays behind the dialog', why: '', fix: 'Move focus into the dialog',
    evidence: {}, confidence: 'fail', ...over,
  };
}

// A second identity on another screen, so the two-identity case exercises grouping as well as
// collapsing: 24 orders interleave the two groups every possible way.
function menu(nth: number, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'pf-menu-state', layer: 'pf', severity: 'moderate', evidenceClass: 'deterministic',
    screenId: 'jobs', elementPath: `main > nav > ul:nth-child(${nth})`,
    elementName: null, role: 'menu',
    whatUserExperiences: 'The menu does not announce whether it is open', why: '', fix: 'Set aria-expanded',
    evidence: {}, confidence: 'fail', ...over,
  };
}

const covered: Coverage = {
  changedFiles: ['src/ClustersPage.tsx'],
  affected: [
    { screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' },
    { screenId: 'jobs', url: 'http://x/jobs', provenance: 'manual' },
  ],
  unresolvedFiles: [], gaps: [], nothingToCheck: false,
};

const base: Omit<GateInput, 'drafts' | 'floor'> = {
  coverage: covered,
  guardDivergedPaths: [],
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set(['clusters', 'jobs']),
};

const emptyFloor: EvidenceFloor = { version: 2, entries: [] };

/**
 * Runs every ordering of `drafts` through the gate and returns the one answer they all gave.
 *
 * Fails loudly naming the first order that disagreed, rather than returning something averaged,
 * so a regression here says which permutation broke it.
 */
function oneAnswerForEveryOrder(drafts: Draft[], floor: EvidenceFloor = emptyFloor): {
  verdict: string | null;
  exitCode: number;
  summary: string;
  findings: string;
} {
  const orders = permutations(drafts);
  expect(orders.length).toBe([1, 1, 2, 6, 24][drafts.length] ?? orders.length);

  const answers = orders.map((order) => {
    const out = gate({ ...base, floor, drafts: order });
    return {
      verdict: out.accessibilityVerdict,
      exitCode: out.accessibilityExitCode,
      summary: out.summary,
      // The whole findings array, canonically serialized: every field of every finding, with
      // object keys sorted so the comparison cannot pass on key insertion order alone.
      findings: canonicalize(out.findings),
    };
  });

  const first = answers[0]!;
  answers.forEach((answer, index) => {
    expect(answer, `order ${index} of ${orders.length} disagreed`).toEqual(first);
  });
  return first;
}

describe('the verdict does not depend on draft arrival order', () => {
  it('gives one answer for a definite failure and an unconfirmed finding at one identity', () => {
    // The reviewed defect, in both orders. `fail` dominates `unverified`, so the collapsed finding
    // is a definite barrier and the run is a regression whichever draft the scanner reported first.
    //
    // The unconfirmed draft is the one that wins the presentation tie-break here, on element path.
    // That is deliberate: if the failing draft also won the tie-break, the collapsed finding would
    // carry `fail` whether or not confidence is aggregated, and this case would pass without
    // proving the rule it is here to prove.
    const answer = oneAnswerForEveryOrder([
      dialog(1, { confidence: 'unverified' }),
      dialog(2),
    ]);

    expect(answer.verdict).toBe('regression');
    expect(answer.exitCode).toBe(1);
    expect(JSON.parse(answer.findings)).toHaveLength(1);
    expect(JSON.parse(answer.findings)[0].confidence).toBe('fail');
  });

  it('gives one answer for three deterministic drafts of mixed confidence, in all six orders', () => {
    const answer = oneAnswerForEveryOrder([
      dialog(1, { confidence: 'unverified' }),
      dialog(2),
      dialog(3, { confidence: 'unverified' }),
    ]);

    expect(answer.verdict).toBe('regression');
    expect(answer.exitCode).toBe(1);
    expect(JSON.parse(answer.findings)[0].confidence).toBe('fail');
  });

  it('gives one answer for two identities of mixed confidence, in all twenty-four orders', () => {
    // Grouping as well as collapsing: the 24 orders interleave two identities on two screens.
    const answer = oneAnswerForEveryOrder([
      dialog(1),
      dialog(2, { confidence: 'unverified' }),
      menu(1, { confidence: 'unverified' }),
      menu(2),
    ]);

    expect(answer.verdict).toBe('regression');
    expect(JSON.parse(answer.findings)).toHaveLength(2);
    for (const finding of JSON.parse(answer.findings)) {
      expect(finding.confidence).toBe('fail');
    }
  });

  it('never lets advisory evidence raise a deterministic finding it shares an identity with', () => {
    // A preview draft that fails, beside a deterministic draft usabl could not confirm. Advisory
    // evidence does not gate, so aggregating across classes would have let it turn an unconfirmed
    // deterministic finding into a definite barrier and mint a regression out of a preview.
    const answer = oneAnswerForEveryOrder([
      dialog(1, { confidence: 'unverified' }),
      dialog(2, { evidenceClass: 'preview', confidence: 'fail' }),
    ]);

    const findings = JSON.parse(answer.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidenceClass).toBe('deterministic');
    expect(findings[0].confidence).toBe('unverified');
    expect(answer.verdict).toBe('not_covered');
    expect(answer.exitCode).toBe(3);
  });

  it('gives one answer for drafts that differ only in severity', () => {
    // Legal ties: identical on class, layer and element path, differing on severity alone. The
    // worst severity represents the group, so the row a reader sees is the most serious barrier
    // behind it rather than the one the scanner happened to report first.
    const answer = oneAnswerForEveryOrder([
      dialog(1, { severity: 'minor' }),
      dialog(1, { severity: 'critical' }),
      dialog(1, { severity: 'moderate' }),
    ]);

    expect(JSON.parse(answer.findings)[0].severity).toBe('critical');
  });

  it('gives one answer for drafts that differ only in prose and evidence', () => {
    // The tie the comparator used to leave to arrival order. Same class, layer, path and severity,
    // different words and different evidence, so only a key over those fields separates them.
    const answer = oneAnswerForEveryOrder([
      dialog(1, { why: 'zebra', fix: 'first fix', evidence: { extra: { probe: 'a' } } }),
      dialog(1, { why: 'alpha', fix: 'second fix', evidence: { extra: { probe: 'b' } } }),
    ]);

    const findings = JSON.parse(answer.findings);
    expect(findings).toHaveLength(1);
    // Both observations survive on the merged evidence, whichever draft won the tie-break.
    expect(findings[0].evidence.extra).toEqual({ probe: expect.any(String) });
  });

  it('gives one answer for duplicated identical drafts', () => {
    // Interchangeable by construction, so this proves the comparator does not throw or reorder on
    // a genuine tie. The count still sees three, which is what the floor is compared against.
    const answer = oneAnswerForEveryOrder([dialog(1), dialog(1), dialog(1)]);

    expect(JSON.parse(answer.findings)).toHaveLength(1);
    expect(answer.verdict).toBe('regression');
  });

  it('gives one answer when the drafts are carried against a floor', () => {
    // Order independence has to hold on the path that reads the floor too, because the count and
    // the status are decided there and both reach the verdict.
    const identity = computeIdentity(dialog(1));
    const floor: EvidenceFloor = {
      version: 2,
      entries: [{
        screenId: 'clusters', layer: 'pf', rule: 'pf-focus-into-dialog',
        elementKey: identity.elementKey, identityBasis: identity.identityBasis, count: 2,
      }],
    };
    const answer = oneAnswerForEveryOrder(
      [dialog(1), dialog(2, { confidence: 'unverified' })],
      floor,
    );

    expect(answer.verdict).toBe('verified');
    expect(JSON.parse(answer.findings)[0].status).toBe('carried');
  });
});
