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

describe('parseBundle voice requirements', () => {
  function voiceRequirement(assertion: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      requirements: [
        {
          id: 'delete-row-announces',
          kind: 'voice',
          surface: 'clusters',
          description: 'Deleting a row announces the deletion',
          approved: true,
          assertion: { type: 'voice', ...assertion },
          ...overrides,
        },
      ],
    };
  }

  const steps = [{ do: 'click', selector: '[data-row="a"] button[aria-label="Delete"]' }];
  const obligation = { class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true };

  function reasonFor(raw: unknown): string {
    const result = parseBundle(raw);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  }

  it('accepts a voice requirement and keeps its steps, obligations, and tab path limit', () => {
    const result = parseBundle(
      voiceRequirement({
        steps,
        obligations: [{ ...obligation, focusedRole: 'button' }],
        maxTabPath: 20,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements[0]).toEqual({
      id: 'delete-row-announces',
      kind: 'voice',
      surface: 'clusters',
      description: 'Deleting a row announces the deletion',
      approved: true,
      assertion: {
        type: 'voice',
        steps,
        obligations: [{ ...obligation, focusedRole: 'button' }],
        maxTabPath: 20,
      },
    });
  });

  it('leaves maxTabPath and focusedRole off when they are not written', () => {
    const result = parseBundle(voiceRequirement({ steps, obligations: [obligation] }));

    expect(result.ok).toBe(true);
    if (!result.ok || result.bundle.requirements[0]?.assertion.type !== 'voice') {
      return;
    }
    const assertion = result.bundle.requirements[0].assertion;
    expect('maxTabPath' in assertion).toBe(false);
    expect('focusedRole' in (assertion.obligations[0] ?? {})).toBe(false);
  });

  it('refuses a voice requirement with no steps', () => {
    expect(reasonFor(voiceRequirement({ steps: [], obligations: [obligation] }))).toMatch(
      /requirements\[0\]\.assertion\.steps: .*at least one step/,
    );
  });

  it('refuses a voice requirement with no obligations', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [] }))).toMatch(
      /requirements\[0\]\.assertion\.obligations: .*at least one obligation/,
    );
  });

  it.each([
    ['past the last step', 1],
    ['negative', -1],
    ['not a whole number', 0.5],
  ])('refuses an afterStep that is %s', (_label, afterStep) => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, afterStep }] }))).toMatch(
      /requirements\[0\]\.assertion\.obligations\[0\]\.afterStep: afterStep must be a whole number from 0 to 0/,
    );
  });

  it('refuses an obligation with no required tokens', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, requiredTokens: [] }] }))).toMatch(
      /requirements\[0\]\.assertion\.obligations\[0\]\.requiredTokens: .*at least one word/,
    );
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only punctuation', '!?.'],
  ])('refuses a required token that is %s, because it would match any announcement', (_label, token) => {
    expect(
      reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, requiredTokens: ['deleted', token] }] })),
    ).toMatch(/requirements\[0\]\.assertion\.obligations\[0\]\.requiredTokens\[1\]: .*letter or digit/);
  });

  it('refuses an obligation with an empty class', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, class: '' }] }))).toMatch(
      /requirements\[0\]\.assertion\.obligations\[0\]\.class: class is required/,
    );
  });

  it('refuses a focusedRole that is not a string', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, focusedRole: 3 }] }))).toContain(
      'requirements[0].assertion.obligations[0].focusedRole',
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['not a whole number', 1.5],
  ])('refuses a maxTabPath that is %s', (_label, maxTabPath) => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [obligation], maxTabPath }))).toMatch(
      /requirements\[0\]\.assertion\.maxTabPath: maxTabPath must be a positive whole number/,
    );
  });

  it('refuses an obligation with an unknown key', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, mustAnnouce: true }] }))).toContain(
      'mustAnnouce',
    );
  });

  it('refuses a voice requirement whose kind does not match its assertion', () => {
    expect(reasonFor(voiceRequirement({ steps, obligations: [obligation] }, { kind: 'flow' }))).toContain(
      'kind must match assertion.type',
    );
  });

  describe('steps', () => {
    function stepReason(step: Record<string, unknown>): string {
      return reasonFor(voiceRequirement({ steps: [step], obligations: [obligation] }));
    }

    it('accepts tab, activate, press with a key, and click with a selector', () => {
      const result = parseBundle(
        voiceRequirement({
          steps: [{ do: 'tab' }, { do: 'activate' }, { do: 'press', key: 'Escape' }, { do: 'click', selector: '#delete' }],
          obligations: [obligation],
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('refuses a step kind it cannot run, and says which kinds it can', () => {
      expect(stepReason({ do: 'clik', selector: '#delete' })).toMatch(
        /requirements\[0\]\.assertion\.steps\[0\]\.do: do must be tab, activate, press, or click/,
      );
    });

    it.each([
      ['missing', {}],
      ['empty', { key: '  ' }],
    ])('refuses a press step whose key is %s', (_label, extra) => {
      expect(stepReason({ do: 'press', ...extra })).toMatch(
        /requirements\[0\]\.assertion\.steps\[0\]\.key: a press step needs a key, such as key: Escape/,
      );
    });

    it.each([
      ['missing', {}],
      ['empty', { selector: '' }],
    ])('refuses a click step whose selector is %s', (_label, extra) => {
      expect(stepReason({ do: 'click', ...extra })).toMatch(
        /requirements\[0\]\.assertion\.steps\[0\]\.selector: a click step needs a selector, such as selector: '#delete'/,
      );
    });

    it('refuses a field a step does not use, and names it', () => {
      expect(stepReason({ do: 'tab', selector: '#delete' })).toMatch(
        /requirements\[0\]\.assertion\.steps\[0\]: selector is not a field of a tab step; write only do: tab/,
      );
    });
  });

  describe('trimmed names', () => {
    it.each([
      ['class', { class: '   ' }, /obligations\[0\]\.class: class is required/],
      ['focusedRole', { focusedRole: '  ' }, /obligations\[0\]\.focusedRole: focusedRole must not be empty/],
    ])('refuses a %s of only spaces', (_label, extra, pattern) => {
      expect(reasonFor(voiceRequirement({ steps, obligations: [{ ...obligation, ...extra }] }))).toMatch(pattern);
    });

    it('stores class and focusedRole trimmed', () => {
      const result = parseBundle(
        voiceRequirement({ steps, obligations: [{ ...obligation, class: ' live-polite ', focusedRole: ' button ' }] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.bundle.requirements[0]?.assertion.type !== 'voice') {
        return;
      }
      expect(result.bundle.requirements[0].assertion.obligations[0]).toMatchObject({ class: 'live-polite', focusedRole: 'button' });
    });

    it('accepts a required token in a non-Latin script', () => {
      expect(parseBundle(voiceRequirement({ steps, obligations: [{ ...obligation, requiredTokens: ['削除'] }] })).ok).toBe(true);
    });
  });
});
