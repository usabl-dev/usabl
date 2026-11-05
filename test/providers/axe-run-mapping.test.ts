/**
 * The axe-shaped mapping shared by the axe provider and engines that return axe-shaped results.
 * The axe provider keeps its exact output. Another layer gets its own layer name, a rule prefix so
 * its identities never merge into axe's, and the evidence class the engine is allowed to claim.
 */
import { describe, expect, it } from 'vitest';
import { mapAxeRunResult, type AxeRunResult } from '../../src/providers/axe/index.js';
import { mapAxeResults as mapFromDriver } from '../../src/deps/real.js';
import { normalizeAxeResults } from '../../src/providers/axe/raw.js';

const RESULT: AxeRunResult = {
  violations: [
    { id: 'button-name', impact: 'critical', description: 'Buttons need a name', nodes: [{ target: ['button.save'] }] },
  ],
  incomplete: [{ id: 'color-contrast', description: 'Check contrast', nodes: [{ target: ['p.note'] }] }],
  passes: [{ id: 'image-alt', nodeCount: 2 }],
  inapplicable: [{ id: 'video-caption', nodeCount: 0 }],
};

describe('mapAxeRunResult', () => {
  it('maps as the axe layer by default', () => {
    const out = mapAxeRunResult(RESULT, 'clusters');
    expect(out.drafts.map((d) => [d.layer, d.rule, d.evidenceClass, d.confidence])).toEqual([
      ['axe', 'button-name', 'deterministic', 'fail'],
      ['axe', 'color-contrast', 'deterministic', 'unverified'],
    ]);
    expect(out.applicability.map((a) => [a.layer, a.rule, a.outcome, a.elementCount])).toEqual([
      ['axe', 'button-name', 'failed', 1],
      ['axe', 'color-contrast', 'incomplete', 1],
      ['axe', 'image-alt', 'passed', 2],
      ['axe', 'video-caption', 'inapplicable', 0],
    ]);
  });

  it('gives another layer its own name, a rule prefix, and its evidence class', () => {
    const out = mapAxeRunResult(RESULT, 'clusters', {
      layer: 'deque',
      rulePrefix: 'deque:',
      evidenceClass: 'preview',
    });
    expect(out.drafts.map((d) => [d.layer, d.rule, d.evidenceClass])).toEqual([
      ['deque', 'deque:button-name', 'preview'],
      ['deque', 'deque:color-contrast', 'preview'],
    ]);
    expect(out.applicability.map((a) => [a.layer, a.rule])).toEqual([
      ['deque', 'deque:button-name'],
      ['deque', 'deque:color-contrast'],
      ['deque', 'deque:image-alt'],
      ['deque', 'deque:video-caption'],
    ]);
  });
});

describe('normalizeAxeResults', () => {
  it('is the mapping the browser driver uses', () => {
    const raw = {
      violations: [{ id: 'x', description: 'd', impact: 'serious', nodes: [{ target: [['iframe', '#a']] }] }],
      incomplete: [],
      passes: [{ id: 'y', nodes: [{}, {}] }],
      inapplicable: 'not a list',
    };
    expect(normalizeAxeResults(raw)).toEqual(mapFromDriver(raw));
    expect(normalizeAxeResults(raw).violations[0]?.nodes[0]?.targetParts).toEqual([['iframe', '#a']]);
  });
});
