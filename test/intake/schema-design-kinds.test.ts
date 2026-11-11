import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/intake/schema.js';

function oneRequirement(kind: string, assertion: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    requirements: [{ id: `r-${kind}`, kind, surface: 'users', description: 'd', assertion, approved: false, ...extra }],
  };
}

function reasonOf(raw: unknown): string {
  const result = parseBundle(raw);
  if (result.ok) {
    throw new Error('expected the bundle to be refused');
  }
  expect(result.verdict).toBe('approval_required');
  return result.reason;
}

describe('design check kinds', () => {
  it.each([
    ['name', { type: 'name', target: { role: 'button', name: 'Refresh' } }],
    ['heading', { type: 'heading', name: 'Users', level: 1 }],
    ['landmark', { type: 'landmark', role: 'main' }],
    ['landmark', { type: 'landmark', role: 'navigation', name: 'Primary' }],
    ['focus-order', { type: 'focus-order', sequence: ['Create user', 'Refresh'] }],
    ['target-size', { type: 'target-size', target: { role: 'button', name: 'Refresh' }, minCssPx: 24 }],
  ])('accepts a %s requirement and keeps its assertion', (kind, assertion) => {
    const result = parseBundle(oneRequirement(kind, assertion));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.requirements[0]?.assertion).toEqual(assertion);
    }
  });

  it('stores names trimmed, the way they are compared', () => {
    const result = parseBundle(oneRequirement('name', { type: 'name', target: { role: 'button', name: '  Refresh ' } }));
    expect(result.ok && result.bundle.requirements[0]?.assertion).toEqual({
      type: 'name',
      target: { role: 'button', name: 'Refresh' },
    });
  });

  it('collapses white space inside a name, the way the browser reports an accessible name', () => {
    const name = parseBundle(oneRequirement('name', { type: 'name', target: { role: 'button', name: 'Create \t user\n' } }));
    expect(name.ok && name.bundle.requirements[0]?.assertion).toEqual({
      type: 'name',
      target: { role: 'button', name: 'Create user' },
    });
    const order = parseBundle(oneRequirement('focus-order', { type: 'focus-order', sequence: ['Create  user', 'Refresh'] }));
    expect(order.ok && order.bundle.requirements[0]?.assertion).toEqual({ type: 'focus-order', sequence: ['Create user', 'Refresh'] });
  });

  it('refuses a focus order whose names repeat once white space is collapsed', () => {
    const reason = reasonOf(oneRequirement('focus-order', { type: 'focus-order', sequence: ['Create user', 'Create  user'] }));
    expect(reason).toContain('repeats');
  });

  it.each([
    ['heading', { type: 'heading', name: 'Users', level: 7 }, 'assertion.level'],
    ['heading', { type: 'heading', name: 'Users', level: 1.5 }, 'assertion.level'],
    ['heading', { type: 'heading', name: ' ', level: 1 }, 'assertion.name'],
    ['landmark', { type: 'landmark', role: 'button' }, 'assertion.role'],
    ['landmark', { type: 'landmark', role: 'main', name: '' }, 'assertion.name'],
    ['name', { type: 'name', target: { role: 'widget', name: 'X' } }, 'assertion.target.role'],
    ['name', { type: 'name', target: { role: 'button', name: '' } }, 'assertion.target.name'],
    ['name', { type: 'name', target: { role: 'button', name: 'X', selector: '#x' } }, 'assertion.target'],
    ['focus-order', { type: 'focus-order', sequence: ['Only one'] }, 'assertion.sequence'],
    ['focus-order', { type: 'focus-order', sequence: ['A', ' '] }, 'assertion.sequence[1]'],
    ['target-size', { type: 'target-size', target: { role: 'button', name: 'R' }, minCssPx: 0 }, 'assertion.minCssPx'],
    ['target-size', { type: 'target-size', target: { role: 'button', name: 'R' }, minCssPx: 201 }, 'assertion.minCssPx'],
    ['target-size', { type: 'target-size', target: { role: 'button', name: 'R' } }, 'assertion.minCssPx'],
  ])('refuses a malformed %s requirement and names the field', (kind, assertion, field) => {
    expect(reasonOf(oneRequirement(kind, assertion))).toContain(`requirements[0].${field}`);
  });

  it('refuses a focus order that repeats a name, because which stop is meant would be a guess', () => {
    const reason = reasonOf(
      oneRequirement('focus-order', { type: 'focus-order', sequence: ['Edit', 'Save', ' Edit'] }),
    );
    expect(reason).toContain('requirements[0].assertion.sequence[2]');
    expect(reason).toContain('repeats');
  });

  it('refuses a kind that does not match its assertion', () => {
    expect(reasonOf(oneRequirement('heading', { type: 'name', target: { role: 'button', name: 'R' } }))).toContain(
      'kind must match assertion.type',
    );
  });
});

describe('design source', () => {
  const heading = { type: 'heading', name: 'Users', level: 1 };
  const source = { tool: 'figma', file: 'ABC123', node: '12:34', version: '42' };

  it('keeps a design source', () => {
    const result = parseBundle(oneRequirement('heading', heading, { source }));
    expect(result.ok && result.bundle.requirements[0]?.source).toEqual(source);
  });

  it('leaves the source off when none is written', () => {
    const result = parseBundle(oneRequirement('heading', heading));
    expect(result.ok && 'source' in (result.bundle.requirements[0] ?? {})).toBe(false);
  });

  it.each([
    [{ ...source, tool: 'other' }, 'source.tool'],
    [{ ...source, file: '' }, 'source.file'],
    [{ ...source, file: 'ABC/../x' }, 'source.file'],
    [{ ...source, node: '12:34​' }, 'source.node'],
    [{ ...source, version: '42\nmore' }, 'source.version'],
    [{ ...source, extra: 'x' }, 'source'],
  ])('refuses a source that could not name a design file node safely', (bad, field) => {
    expect(reasonOf(oneRequirement('heading', heading, { source: bad }))).toContain(`requirements[0].${field}`);
  });
});
