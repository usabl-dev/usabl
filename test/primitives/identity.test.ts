import { describe, it, expect } from 'vitest';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Draft } from '../../src/contracts/index.js';

function draft(over: Partial<Draft>): Draft {
  return {
    rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'main > div:nth-of-type(2) > button', elementName: null,
    role: 'button', whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
    ...over,
  };
}

describe('computeIdentity', () => {
  it('uses the accessible name when present', () => {
    const id = computeIdentity(draft({ evidence: { name: { value: 'Delete cluster', source: 'ax-tree', fromTree: true } } }));
    expect(id.identityBasis).toBe('name');
    expect(id.elementKey).toBe('clusters|color-contrast|name:delete-cluster');
  });

  it('is count-based (no key) for identity-weak unnamed rules', () => {
    const id = computeIdentity(draft({ rule: 'button-name', evidence: {} }));
    expect(id.identityBasis).toBe('count');
    expect(id.elementKey).toBeNull();
  });

  it('falls back to structural (role + neutralized path) with no name', () => {
    const id = computeIdentity(draft({ role: 'button', evidence: {} }));
    expect(id.identityBasis).toBe('structural');
    expect(id.elementKey).toBe('clusters|color-contrast|struct:button:main>div>button');
  });
});
