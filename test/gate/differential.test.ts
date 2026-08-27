import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
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
const base = { guardDivergedPaths: [] as string[], waivers: [], now: '2026-01-01T00:00:00.000Z', coverage: covered };
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
