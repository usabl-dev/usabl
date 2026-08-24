import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/intake/schema.js';

describe('parseBundle', () => {
  it('accepts a valid content bundle', () => {
    const result = parseBundle({
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
    });

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
});
