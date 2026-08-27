import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import type { Coverage, Draft, EvidenceFloor, Waiver } from '../../src/contracts/index.js';

const covered: Coverage = {
  changedFiles: ['x'], affected: [{ screenId: 'clusters', url: 'u', provenance: 'manual' }],
  unresolvedFiles: [], gaps: [], nothingToCheck: false,
};
const floor: EvidenceFloor = { version: 1, entries: [] };
const draft: Draft = {
  rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
  screenId: 'clusters', elementPath: 'button', elementName: 'Save', role: 'button',
  whatUserExperiences: '', why: '', fix: '',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } }, confidence: 'fail',
};
const waiver = (over: Partial<Waiver>): Waiver => ({
  rule: 'color-contrast', surface: 'clusters', scope: 'clusters|color-contrast|name:save',
  reason: 'tracked', owner: 'team', approvedBy: 'owner',
  created: '2026-01-01T00:00:00.000Z', expires: '2026-12-31T00:00:00.000Z', ...over,
});
const base = { guardDivergedPaths: [] as string[], coverage: covered, floor, drafts: [draft] };

describe('gate waivers', () => {
  it('waives a matching active finding so it does not regress', () => {
    const out = gate({ ...base, waivers: [waiver({})], now: '2026-06-01T00:00:00.000Z' });
    expect(out.findings.find((f) => f.rule === 'color-contrast')!.status).toBe('waived');
    expect(out.verdict).toBe('verified');
  });

  it('ignores an expired waiver so the finding regresses', () => {
    const out = gate({ ...base, waivers: [waiver({ expires: '2026-02-01T00:00:00.000Z' })], now: '2026-06-01T00:00:00.000Z' });
    expect(out.findings.find((f) => f.rule === 'color-contrast')!.status).toBe('new');
    expect(out.verdict).toBe('regression');
  });


  it('treats a waiver as expired when expires equals now', () => {
    const out = gate({ ...base, waivers: [waiver({ expires: '2026-06-01T00:00:00.000Z' })], now: '2026-06-01T00:00:00.000Z' });
    expect(out.findings.find((f) => f.rule === 'color-contrast')!.status).toBe('new');
    expect(out.verdict).toBe('regression');
  });
  it('matches a wildcard scope for the whole rule on the surface', () => {
    const out = gate({ ...base, waivers: [waiver({ scope: '*' })], now: '2026-06-01T00:00:00.000Z' });
    expect(out.verdict).toBe('verified');
  });
});
