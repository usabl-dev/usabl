/**
 * Engine findings at the gate. Deque and Evinced findings are preview in this release, and preview
 * never moves the verdict. A promoted Evinced type, which only the mapping can make today, gates as
 * deterministic evidence. Vendor rules keep identities of their own, so they never merge into an axe
 * floor entry or waiver.
 */
import { describe, expect, it } from 'vitest';
import type { Coverage, Draft, EvidenceFloor } from '../../src/contracts/index.js';
import { gate } from '../../src/gate/index.js';
import { mapAxeRunResult } from '../../src/providers/axe/index.js';
import { mapDequeResults } from '../../src/providers/engines/deque.js';
import { mapEvincedIssues } from '../../src/providers/engines/evinced.js';

const emptyFloor: EvidenceFloor = { version: 2, entries: [] };
const covered: Coverage = {
  changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
  affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};
const base = {
  coverage: covered,
  guardDivergedPaths: [] as string[],
  floor: emptyFloor,
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set<string>(['clusters']),
};

const WRONG_ROLE = {
  type: { id: 'WRONG_SEMANTIC_ROLE', name: 'Wrong Semantic Role' },
  severity: { name: 'Critical' },
  elements: [{ selector: 'div.toolbar > span.btn' }],
};

function evincedDrafts(promote: string[]): Draft[] {
  return mapEvincedIssues([WRONG_ROLE], 'clusters', new Set(promote)).drafts;
}

const BUTTON_NAME = {
  id: 'button-name',
  impact: 'critical' as const,
  description: 'Buttons need a name',
  nodes: [{ target: ['button.save'] }],
};

describe('engine evidence at the gate', () => {
  it('shows a preview Evinced finding without changing the verdict', () => {
    const out = gate({ ...base, drafts: evincedDrafts([]) });
    expect(out.verdict).toBe('verified');
    expect(out.exitCode).toBe(0);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ rule: 'evinced:WRONG_SEMANTIC_ROLE', evidenceClass: 'preview', status: 'new' });
  });

  it('gates a promoted Evinced type as a regression', () => {
    const out = gate({ ...base, drafts: evincedDrafts(['WRONG_SEMANTIC_ROLE']) });
    expect(out.verdict).toBe('regression');
    expect(out.exitCode).toBe(1);
    expect(out.findings[0]).toMatchObject({ evidenceClass: 'deterministic', status: 'new' });
  });

  it('shows a preview Deque finding without changing the verdict', () => {
    const deque = mapDequeResults(
      { violations: [BUTTON_NAME], incomplete: [], passes: [], inapplicable: [] },
      'clusters',
      new Set(),
    ).drafts;
    const out = gate({ ...base, drafts: deque });
    expect(out.verdict).toBe('verified');
    expect(out.findings.map((finding) => [finding.rule, finding.evidenceClass])).toEqual([
      ['deque:button-name', 'preview'],
    ]);
  });

  it('keeps a Deque finding apart from an axe finding on the same rule and element', () => {
    const result = { violations: [BUTTON_NAME], incomplete: [], passes: [], inapplicable: [] };
    const axeDraft = mapAxeRunResult(result, 'clusters').drafts;
    // An empty open-source rule set keeps the id, which is the worst case for a collision.
    const dequeDraft = mapDequeResults(
      { violations: [{ ...BUTTON_NAME, nodes: [{ target: ['button.save'] }] }], incomplete: [], passes: [], inapplicable: [] },
      'clusters',
      new Set(),
    ).drafts;

    const out = gate({ ...base, drafts: [...axeDraft, ...dequeDraft] });

    expect(out.verdict).toBe('regression');
    expect(out.findings.map((finding) => [finding.layer, finding.rule, finding.evidenceClass]).sort()).toEqual([
      ['axe', 'button-name', 'deterministic'],
      ['deque', 'deque:button-name', 'preview'],
    ]);
    expect(new Set(out.findings.map((finding) => finding.elementKey)).size).toBe(2);
  });
});
