import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/intake/schema.js';
import type { RequirementBundle } from '../../src/contracts/index.js';

function validBundle(): RequirementBundle {
  return {
    version: 1,
    requirements: [
      {
        id: 'req-content-1',
        kind: 'content',
        surface: 'home',
        description: 'Primary heading should be present',
        assertion: {
          type: 'content',
          selector: 'h1',
          expectedText: 'Welcome',
        },
        approved: true,
      },
    ],
  };
}

describe('parseBundle', () => {
  it('accepts a valid content bundle', () => {
    const result = parseBundle(validBundle());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements).toHaveLength(1);
    expect(result.bundle.requirements[0]?.kind).toBe('content');
  });

  it('fails closed when required fields are missing', () => {
    const result = parseBundle({
      version: 1,
      requirements: [
        {
          id: 'req-missing-description',
          kind: 'content',
          surface: 'home',
          assertion: {
            type: 'content',
            selector: 'h1',
          },
          approved: true,
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('fails closed when kind does not match assertion.type', () => {
    const result = parseBundle({
      version: 1,
      requirements: [
        {
          id: 'req-mismatch-1',
          kind: 'flow',
          surface: 'settings',
          description: 'Settings heading text',
          assertion: {
            type: 'content',
            selector: 'h2',
            expectedText: 'Settings',
          },
          approved: true,
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('accepts a valid doc requirement', () => {
    const result = parseBundle({
      version: 1,
      requirements: [
        {
          id: 'req-doc-1',
          kind: 'doc',
          surface: 'profile',
          description: 'Document alt text for profile avatar',
          assertion: {
            type: 'doc',
            artifact: 'alt-text-manifest',
          },
          owner: 'a11y-team',
          approved: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements[0]?.assertion.type).toBe('doc');
  });

  it('fails closed when bundle contains unknown keys', () => {
    const result = parseBundle({
      ...validBundle(),
      extraBundleKey: 'unexpected',
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('extraBundleKey');
  });

  it('fails closed when requirement contains unknown keys', () => {
    const bundle = validBundle();
    const [firstRequirement] = bundle.requirements;
    if (firstRequirement === undefined) {
      throw new Error('test fixture must include one requirement');
    }

    const result = parseBundle({
      ...bundle,
      requirements: [
        {
          ...firstRequirement,
          extraRequirementKey: 'unexpected',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('extraRequirementKey');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['scalar number', 42],
    ['array', []],
  ])('fails closed for degenerate bundle input: %s', (_label, raw) => {
    const result = parseBundle(raw);

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('fails closed when bundle version is unsupported', () => {
    const result = parseBundle({
      ...validBundle(),
      version: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('fails closed when requirements list is empty', () => {
    const result = parseBundle({
      ...validBundle(),
      requirements: [],
    });

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });
});
