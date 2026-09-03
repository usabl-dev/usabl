import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Coverage, Draft, EvidenceFloor, Finding } from '../../src/contracts/index.js';

const covered: Coverage = {
  changedFiles: ['x'], affected: [{ screenId: 'clusters', url: 'u', provenance: 'manual' }],
  unresolvedFiles: [], gaps: [], nothingToCheck: false,
};
function d(over: Partial<Draft>): Draft {
  return {
    rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'button', elementName: 'Save', role: 'button',
    whatUserExperiences: '', why: '', fix: '',
    evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } }, confidence: 'fail', ...over,
  };
}
// clusters is the only screen these cases measure, and they measure it cleanly. Stating that here
// is the precondition a `fixed` claim depends on: the gate marks a disappeared floor identity fixed
// only for a screen it was told was scanned clean this run.
const base = {
  guardDivergedPaths: [] as string[],
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  coverage: covered,
  cleanlyScannedScreens: new Set(['clusters']),
};
const find = (out: { findings: Finding[] }, rule: string) => out.findings.filter((f) => f.rule === rule);

describe('gate differential', () => {
  it('marks a finding already in the floor as carried and does not regress', () => {
    const floor: EvidenceFloor = { version: 1, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'color-contrast', elementKey: 'clusters|color-contrast|name:save', identityBasis: 'name', count: 1 },
    ] };
    const out = gate({ ...base, floor, drafts: [d({})] });
    expect(find(out, 'color-contrast')[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
  });

  it('marks a disappeared floor entry as fixed', () => {
    const floor: EvidenceFloor = { version: 1, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'gone-rule', elementKey: 'clusters|gone-rule|name:save', identityBasis: 'name', count: 1 },
    ] };
    const out = gate({ ...base, floor, drafts: [] });
    expect(find(out, 'gone-rule')[0]!.status).toBe('fixed');
    expect(out.verdict).toBe('verified');
  });

  it('gives fixed findings honest placeholder text instead of blank strings', () => {
    const floor: EvidenceFloor = { version: 1, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'gone-rule', elementKey: 'clusters|gone-rule|name:save', identityBasis: 'name', count: 1 },
    ] };
    const out = gate({ ...base, floor, drafts: [] });
    const fixed = find(out, 'gone-rule')[0]!;
    expect(fixed.whatUserExperiences.length).toBeGreaterThan(0);
    expect(fixed.why.length).toBeGreaterThan(0);
    expect(fixed.fix.length).toBeGreaterThan(0);
    expect(fixed.whatUserExperiences.toLowerCase()).toMatch(/no longer present|not observed|fixed/);
  });

  it('dedups the same defect across axe and pf, preferring the pf why/fix', () => {
    const floor: EvidenceFloor = { version: 1, entries: [] };
    const axe = d({ layer: 'axe', why: 'axe why', fix: 'axe fix' });
    const pf = d({ layer: 'pf', why: 'pf why', fix: 'pf fix' });
    const out = gate({ ...base, floor, drafts: [axe, pf] });
    const kept = find(out, 'color-contrast');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.why).toBe('pf why');
    expect(kept[0]!.fix).toBe('pf fix');
  });

  it('keeps axe evidence fields when PatternFly wins the same identity', () => {
    const floor: EvidenceFloor = { version: 1, entries: [] };
    const axe = d({
      layer: 'axe',
      why: 'axe why',
      fix: 'axe fix',
      evidence: {
        name: { value: 'Save', source: 'ax-tree', fromTree: true },
        state: { expanded: { value: false, source: 'attribute', fromTree: true } },
        extra: { axeId: 'color-contrast' },
      },
    });
    const pf = d({
      layer: 'pf',
      why: 'pf why',
      fix: 'pf fix',
      evidence: {
        name: { value: 'Save', source: 'ax-tree', fromTree: true },
        extra: { pfToken: 'contrast' },
      },
    });
    const out = gate({ ...base, floor, drafts: [axe, pf] });
    const kept = find(out, 'color-contrast')[0]!;
    expect(kept.layer).toBe('pf');
    expect(kept.evidence.extra).toEqual({ axeId: 'color-contrast', pfToken: 'contrast' });
    expect(kept.evidence.state).toEqual({
      expanded: { value: false, source: 'attribute', fromTree: true },
    });
  });

  it('carries a structural finding across a rescan that remounted generated ids', () => {
    // Round one recorded the floor. Round two saw the same unchanged screen with a
    // fresh React generated id. Identity must not move, or the same barrier reads
    // as fixed and new at once and a clean tree reports a regression.
    const roundOne = d({ role: 'generic', evidence: {}, elementPath: '#pf-random-id-\\:r39\\:' });
    const roundTwo = d({ role: 'generic', evidence: {}, elementPath: '#pf-random-id-\\:r3v\\:' });
    const floor: EvidenceFloor = { version: 1, entries: [
      {
        screenId: 'clusters', layer: 'axe', rule: 'color-contrast',
        elementKey: computeIdentity(roundOne).elementKey,
        identityBasis: 'structural', count: 1,
      },
    ] };
    const out = gate({ ...base, floor, drafts: [roundTwo] });
    const kept = find(out, 'color-contrast');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
  });

  it('regresses when a count-based rule increases over the floor', () => {
    const floor: EvidenceFloor = { version: 1, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 1 },
    ] };
    const drafts = [d({ rule: 'button-name', evidence: {} }), d({ rule: 'button-name', evidence: {}, elementPath: 'button2' })];
    const out = gate({ ...base, floor, drafts });
    expect(out.verdict).toBe('regression');
  });

  it('does not regress when a count-based rule matches the floor count', () => {
    const floor: EvidenceFloor = { version: 1, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 1 },
    ] };
    const out = gate({ ...base, floor, drafts: [d({ rule: 'button-name', evidence: {} })] });
    expect(out.verdict).toBe('verified');
  });
});

// Three barriers on different nodes can neutralize to one structural key. They collapse to a
// single finding in gate output, so only a count comparison can tell one floored barrier from three.
const STRUCT_KEY = 'clusters|pf-focus-into-dialog|struct:dialog:main>div>section';
function structDraft(nth: number): Draft {
  return d({
    rule: 'pf-focus-into-dialog',
    layer: 'pf',
    evidence: {},
    elementName: null,
    role: 'dialog',
    elementPath: `main > div:nth-child(${nth}) > section`,
  });
}
function structEntry(version: 1 | 2, count: number): EvidenceFloor {
  return { version, entries: [
    { screenId: 'clusters', layer: 'pf', rule: 'pf-focus-into-dialog', elementKey: STRUCT_KEY, identityBasis: 'structural', count },
  ] };
}

describe('gate collapsed identity counts', () => {
  it('gates three collapsed structural findings as new against a version 2 floor of one', () => {
    const out = gate({ ...base, floor: structEntry(2, 1), drafts: [structDraft(1), structDraft(2), structDraft(3)] });
    const collapsed = find(out, 'pf-focus-into-dialog');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.status).toBe('new');
    expect(out.verdict).toBe('regression');
  });

  it('keeps three collapsed structural findings carried against a version 1 floor', () => {
    const out = gate({ ...base, floor: structEntry(1, 1), drafts: [structDraft(1), structDraft(2), structDraft(3)] });
    expect(find(out, 'pf-focus-into-dialog')[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
  });

  it('keeps an equal structural count carried against a version 2 floor', () => {
    const out = gate({ ...base, floor: structEntry(2, 3), drafts: [structDraft(1), structDraft(2), structDraft(3)] });
    expect(find(out, 'pf-focus-into-dialog')[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
  });

  it('keeps a reduced structural count carried against a version 2 floor', () => {
    const out = gate({ ...base, floor: structEntry(2, 3), drafts: [structDraft(1)] });
    expect(find(out, 'pf-focus-into-dialog')[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
  });

  it('gates duplicate name-basis findings as new against a version 2 floor of one', () => {
    const floor: EvidenceFloor = { version: 2, entries: [
      { screenId: 'clusters', layer: 'axe', rule: 'color-contrast', elementKey: 'clusters|color-contrast|name:save', identityBasis: 'name', count: 1 },
    ] };
    const out = gate({ ...base, floor, drafts: [d({}), d({ elementPath: 'footer button' })] });
    expect(find(out, 'color-contrast')[0]!.status).toBe('new');
    expect(out.verdict).toBe('regression');
  });
});
