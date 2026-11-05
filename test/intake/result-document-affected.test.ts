/**
 * The reason a dependency change queued a screen keeps through the coverage reader that the gate
 * and the Result document go through, so the screen still says which file made it wide blast.
 */
import { describe, expect, it } from 'vitest';
import { readCoverageShape } from '../../src/intake/result-document.js';

const coverage = (affected: unknown[]): unknown => ({ changedFiles: ['yarn.lock'], affected, unresolvedFiles: [], gaps: [], nothingToCheck: false });

describe('an affected screen in a coverage document', () => {
  it('keeps the reason of a wide-blast screen, and adds none where there is none', () => {
    const queued = { screenId: 'home', url: 'http://app.test/', provenance: 'wide-blast', reason: 'yarn.lock is a lockfile.' };
    const plain = { screenId: 'users', url: 'http://app.test/users', provenance: 'route-graph' };
    expect(readCoverageShape(coverage([queued, plain]), 'coverage', 'test').affected).toEqual([queued, plain]);
  });

  it('refuses a reason that is not text', () => {
    expect(() => readCoverageShape(coverage([{ screenId: 'home', url: 'http://app.test/', provenance: 'wide-blast', reason: 7 }]), 'coverage', 'test')).toThrow(
      /reason/,
    );
  });
});
