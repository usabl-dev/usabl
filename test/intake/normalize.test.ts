import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/intake/normalize.js';

describe('normalize', () => {
  it('parses valid YAML into a requirement bundle', () => {
    const raw = `
version: 1
requirements:
  - id: req-content-2
    kind: content
    surface: dashboard
    description: Dashboard greeting text
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
`;

    const result = normalize(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.bundle.requirements).toHaveLength(1);
    expect(result.bundle.requirements[0]?.assertion.type).toBe('content');
  });

  it('fails closed for invalid YAML syntax', () => {
    const raw = `
version: 1
requirements:
  - id: req-bad-yaml
    kind: content
    surface: dashboard
    description: broken
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
  broken: [1, 2
`;

    const result = normalize(raw);
    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('fails closed when YAML parses but does not satisfy schema', () => {
    const raw = `
version: 1
requirements:
  - id: req-schema-fail
    kind: flow
    surface: checkout
    description: Checkout completion announcement
    assertion:
      type: flow
      steps:
        - do: click
          selector: "#submit-order"
`;

    const result = normalize(raw);
    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });

  it('fails closed for YAML custom tags outside JSON schema', () => {
    const raw = `
version: 1
requirements:
  - id: req-custom-tag
    kind: content
    surface: dashboard
    description: custom tag must be rejected
    assertion:
      type: content
      selector: !!js/function "function () { return 'h1'; }"
      expectedText: Hello
    approved: true
`;

    const result = normalize(raw);
    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
    });
  });
});
