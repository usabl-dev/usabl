import { describe, it, expect } from 'vitest';
import { computeIdentity, identityKey } from '../../src/primitives/identity.js';
import type { Draft } from '../../src/contracts/index.js';

function draft(over: Partial<Draft>): Draft {
  return {
    rule: 'color-contrast', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'main > div:nth-of-type(2) > button', elementName: null,
    role: 'button', whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
    ...over,
  };
}

describe('identityKey', () => {
  it('encodes screen, rule, and elementKey so gate, baseline, and prune stay aligned', () => {
    expect(
      identityKey({
        screenId: 'clusters',
        rule: 'color-contrast',
        elementKey: 'clusters|color-contrast|name:save',
      }),
    ).toBe('["clusters","color-contrast","clusters|color-contrast|name:save"]');
  });

  it('uses the count sentinel when elementKey is null', () => {
    expect(identityKey({ screenId: 'clusters', rule: 'button-name', elementKey: null })).toBe(
      '["clusters","button-name","count"]',
    );
  });

  it('is injective when a field contains the delimiter', () => {
    // A plain "a|b|c" join collides here: both triples flatten to a|intake:b|intake:c|name:save,
    // which would let one finding be marked carried against the other finding's floor entry.
    // The encoding must keep them distinct.
    const a = identityKey({ screenId: 'a|intake:b', rule: 'intake:c', elementKey: 'name:save' });
    const b = identityKey({ screenId: 'a', rule: 'intake:b|intake:c', elementKey: 'name:save' });
    expect(a).not.toBe(b);
  });
});

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

  // Paths below are copied from three scans of one unchanged PatternFly screen.
  // The element never moved; only React's per-mount generated id changed.
  it('keys the same element the same way when only a PatternFly generated id differs', () => {
    const a = computeIdentity(draft({ role: 'generic', evidence: {}, elementPath: '#pf-random-id-\\:r39\\:' }));
    const b = computeIdentity(draft({ role: 'generic', evidence: {}, elementPath: '#pf-random-id-\\:r3v\\:' }));
    expect(a.identityBasis).toBe('structural');
    expect(a.elementKey).toBe(b.elementKey);
  });

  it('keys the same element the same way when the generated id is a path ancestor', () => {
    const a = computeIdentity(draft({ role: null, evidence: {}, elementPath: '#pf-random-id-\\:r39\\: > div > div' }));
    const b = computeIdentity(draft({ role: null, evidence: {}, elementPath: '#pf-random-id-\\:r3v\\: > div > div' }));
    expect(a.elementKey).toBe(b.elementKey);
  });

  it('keys the same element the same way for a bare React useId with no PatternFly wrapper', () => {
    const a = computeIdentity(draft({ evidence: {}, elementPath: '#\\:r39\\: > button' }));
    const b = computeIdentity(draft({ evidence: {}, elementPath: '#\\:r3v\\: > button' }));
    expect(a.elementKey).toBe(b.elementKey);
  });

  it('keeps structurally distinct siblings apart even when both carry generated ids', () => {
    const a = computeIdentity(draft({ evidence: {}, elementPath: '#pf-random-id-\\:r39\\: > div > span' }));
    const b = computeIdentity(draft({ evidence: {}, elementPath: '#pf-random-id-\\:r3v\\: > div > div' }));
    expect(a.elementKey).not.toBe(b.elementKey);
  });

  it('leaves an author-written id alone, digits and all', () => {
    const id = computeIdentity(draft({ evidence: {}, elementPath: '#cluster-list-2 > div:nth-child(3) > button' }));
    expect(id.elementKey).toBe('clusters|color-contrast|struct:button:#cluster-list-2>div>button');
  });

  it('leaves an unescaped pseudo-class alone', () => {
    const id = computeIdentity(draft({ evidence: {}, elementPath: 'form > input:required:focus' }));
    expect(id.elementKey).toBe('clusters|color-contrast|struct:button:form>input:required:focus');
  });

  it('still prefers the accessible name when the path holds a generated id', () => {
    const id = computeIdentity(draft({
      elementPath: '#pf-random-id-\\:r39\\: > button',
      evidence: { name: { value: 'Delete cluster', source: 'ax-tree', fromTree: true } },
    }));
    expect(id.identityBasis).toBe('name');
    expect(id.elementKey).toBe('clusters|color-contrast|name:delete-cluster');
  });

  it('stays count-based for identity-weak rules when the path holds a generated id', () => {
    const id = computeIdentity(draft({ rule: 'button-name', evidence: {}, elementPath: '#pf-random-id-\\:r39\\:' }));
    expect(id.identityBasis).toBe('count');
    expect(id.elementKey).toBeNull();
  });
});
