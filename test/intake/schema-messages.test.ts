import { describe, expect, it } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { normalize } from '../../src/intake/normalize.js';
import { parseBundle } from '../../src/intake/schema.js';
import { testConfig } from '../helpers.js';

// These tests pin the exact text a person reads when a requirement file is refused, and the
// shape a valid file keeps. The schema library writes some of that text itself, so a change of
// library version could change it without any change here. Each case names one rule.

const contentAssertion = { type: 'content', selector: 'h1' };

function requirement(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    kind: 'content',
    surface: 'home',
    description: 'd',
    assertion: contentAssertion,
    approved: true,
    ...over,
  };
}

function bundle(entry: unknown, extra: Record<string, unknown> = {}): unknown {
  return { version: 1, requirements: [entry], ...extra };
}

function requirementWithout(key: string): Record<string, unknown> {
  const entry = requirement();
  delete entry[key];
  return entry;
}

const voiceAssertion = {
  type: 'voice',
  steps: [{ do: 'click', selector: '#x' }],
  obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }],
};

function voice(over: Record<string, unknown>): unknown {
  return bundle(requirement({ kind: 'voice', assertion: { ...voiceAssertion, ...over } }));
}

function obligation(over: Record<string, unknown>): unknown {
  return voice({ obligations: [{ ...voiceAssertion.obligations[0], ...over }] });
}

function targetSize(over: Record<string, unknown>): unknown {
  return bundle(
    requirement({
      kind: 'target-size',
      assertion: { type: 'target-size', target: { role: 'button', name: 'R' }, minCssPx: 24, ...over },
    }),
  );
}

function reasonOf(raw: unknown): string {
  const result = parseBundle(raw);
  if (result.ok) {
    throw new Error('expected the bundle to be refused');
  }
  expect(result.verdict).toBe('approval_required');
  return result.reason;
}

const KINDS = "'content' | 'flow' | 'doc' | 'voice' | 'name' | 'heading' | 'landmark' | 'focus-order' | 'target-size'";

describe('requirement file messages', () => {
  it.each<[string, unknown, string]>([
    ['a file that is not an object', 'text', 'bundle: Expected object, received string'],
    ['a file that is null', null, 'bundle: Expected object, received null'],
    ['a file that is a list', [], 'bundle: Expected object, received array'],
    ['an unknown key in the file', bundle(requirement(), { extra: 1 }), "bundle: Unrecognized key(s) in object: 'extra'"],
    [
      'two unknown keys in a requirement',
      bundle(requirement({ extraA: 1, extraB: 2 })),
      "requirements[0]: Unrecognized key(s) in object: 'extraA', 'extraB'",
    ],
    [
      'an unknown key in an assertion',
      bundle(requirement({ assertion: { ...contentAssertion, colour: 'red' } })),
      "requirements[0].assertion: Unrecognized key(s) in object: 'colour'",
    ],
    ['a missing field', bundle(requirementWithout('approved')), 'requirements[0].approved: Required'],
    ['a missing assertion', bundle(requirementWithout('assertion')), 'requirements[0].assertion: Required'],
    ['a missing version', { requirements: [requirement()] }, 'version: Invalid literal value, expected 1'],
    ['an unsupported version', { version: 2, requirements: [requirement()] }, 'version: Invalid literal value, expected 1'],
    ['a field of the wrong type', bundle(requirement({ approved: 'yes' })), 'requirements[0].approved: Expected boolean, received string'],
    ['an id that is a number', bundle(requirement({ id: 7 })), 'requirements[0].id: Expected string, received number'],
    ['a null where text belongs', bundle(requirement({ owner: null })), 'requirements[0].owner: Expected string, received null'],
    [
      'a kind that does not exist',
      bundle(requirement({ kind: 'bogus' })),
      `requirements[0].kind: Invalid enum value. Expected ${KINDS}, received 'bogus'`,
    ],
    ['requirements that are not a list', { version: 1, requirements: {} }, 'requirements: Expected array, received object'],
    [
      'an assertion type that does not exist',
      bundle(requirement({ assertion: { type: 'bogus' } })),
      `requirements[0].assertion.type: Invalid discriminator value. Expected ${KINDS}`,
    ],
    ['an assertion that is not an object', bundle(requirement({ assertion: 'h1' })), 'requirements[0].assertion: Expected object, received string'],
    [
      'an empty field and a kind that does not match',
      bundle(requirement({ description: '', kind: 'flow' })),
      'requirements[0].description: description is required; requirements[0].kind: kind must match assertion.type',
    ],
    [
      'a content check value that does not exist',
      bundle(requirement({ assertion: { ...contentAssertion, mustNotBe: 'hidden' } })),
      "requirements[0].assertion.mustNotBe: Invalid enum value. Expected 'decorative' | 'empty', received 'hidden'",
    ],
    [
      'a document artifact that does not exist',
      bundle(requirement({ kind: 'doc', assertion: { type: 'doc', artifact: 'x' } })),
      "requirements[0].assertion.artifact: Invalid enum value. Expected 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths', received 'x'",
    ],
    [
      'a heading level out of range',
      bundle(requirement({ kind: 'heading', assertion: { type: 'heading', name: 'U', level: 7 } })),
      'requirements[0].assertion.level: level must be a whole number from 1 to 6',
    ],
    [
      'a heading level that is text',
      bundle(requirement({ kind: 'heading', assertion: { type: 'heading', name: 'U', level: 'two' } })),
      'requirements[0].assertion.level: level must be a whole number from 1 to 6',
    ],
    [
      'a missing heading level',
      bundle(requirement({ kind: 'heading', assertion: { type: 'heading', name: 'U' } })),
      'requirements[0].assertion.level: level must be a whole number from 1 to 6',
    ],
    [
      'a landmark role that is not a landmark',
      bundle(requirement({ kind: 'landmark', assertion: { type: 'landmark', role: 'button' } })),
      "requirements[0].assertion.role: Invalid enum value. Expected 'main' | 'navigation' | 'banner' | 'contentinfo' | 'complementary' | 'region' | 'search' | 'form', received 'button'",
    ],
    [
      'a missing target name',
      bundle(requirement({ kind: 'name', assertion: { type: 'name', target: { role: 'button' } } })),
      'requirements[0].assertion.target.name: Required',
    ],
    [
      'a target name that is a number',
      bundle(requirement({ kind: 'name', assertion: { type: 'name', target: { role: 'button', name: 3 } } })),
      'requirements[0].assertion.target.name: Expected string, received number',
    ],
    [
      'a missing minCssPx',
      targetSize({ minCssPx: undefined }),
      'requirements[0].assertion.minCssPx: minCssPx is required: the smallest width and height, in CSS pixels, such as 24',
    ],
    ['a minCssPx that is text', targetSize({ minCssPx: 'big' }), 'requirements[0].assertion.minCssPx: Expected number, received string'],
    ['an infinite minCssPx', targetSize({ minCssPx: Infinity }), 'requirements[0].assertion.minCssPx: minCssPx must be at most 200 CSS pixels'],
    ['a minCssPx that is not a number', targetSize({ minCssPx: NaN }), 'requirements[0].assertion.minCssPx: Expected number, received nan'],
    [
      'an infinite afterStep',
      obligation({ afterStep: Infinity }),
      'requirements[0].assertion.obligations[0].afterStep: afterStep must be a whole number from 0 to 0, the position of a step in steps counted from 0',
    ],
    ['an afterStep that is text', obligation({ afterStep: '0' }), 'requirements[0].assertion.obligations[0].afterStep: Expected number, received string'],
    ['a missing afterStep', obligation({ afterStep: undefined }), 'requirements[0].assertion.obligations[0].afterStep: Required'],
    [
      'an infinite maxTabPath',
      voice({ maxTabPath: Infinity }),
      'requirements[0].assertion.maxTabPath: maxTabPath must be a positive whole number, the most focus stops the task may take, or left out',
    ],
    [
      'a negative infinite maxTabPath',
      voice({ maxTabPath: -Infinity }),
      'requirements[0].assertion.maxTabPath: maxTabPath must be a positive whole number, the most focus stops the task may take, or left out',
    ],
    ['a missing mustAnnounce', obligation({ mustAnnounce: undefined }), 'requirements[0].assertion.obligations[0].mustAnnounce: Required'],
    [
      'a required token that is a number',
      obligation({ requiredTokens: [3] }),
      'requirements[0].assertion.obligations[0].requiredTokens[0]: Expected string, received number',
    ],
    [
      'a voice step kind that does not exist',
      voice({ steps: [{ do: 'clik' }] }),
      'requirements[0].assertion.steps[0].do: do must be tab, activate, press, or click; to press another key, write do: press with key, such as key: Escape',
    ],
    [
      'a voice step with no kind',
      voice({ steps: [{ selector: '#x' }] }),
      'requirements[0].assertion.steps[0].do: do must be tab, activate, press, or click; to press another key, write do: press with key, such as key: Escape',
    ],
    [
      'a voice step with fields it does not use',
      voice({ steps: [{ do: 'tab', selector: '#x', key: 'a' }] }),
      'requirements[0].assertion.steps[0]: selector, key is not a field of a tab step; write only do: tab',
    ],
    ['a press step with no key', voice({ steps: [{ do: 'press' }] }), 'requirements[0].assertion.steps[0].key: a press step needs a key, such as key: Escape'],
    ['a press step whose key is a number', voice({ steps: [{ do: 'press', key: 3 }] }), 'requirements[0].assertion.steps[0].key: a press step needs a key, such as key: Escape'],
    [
      'a click step with a blank selector',
      voice({ steps: [{ do: 'click', selector: '  ' }] }),
      "requirements[0].assertion.steps[0].selector: a click step needs a selector, such as selector: '#delete'",
    ],
    ['a voice step that is not an object', voice({ steps: ['tab'] }), 'requirements[0].assertion.steps[0]: Expected object, received string'],
    [
      'a flow step with no action',
      bundle(requirement({ kind: 'flow', assertion: { type: 'flow', steps: [{ wait: 1 }] } })),
      'requirements[0].assertion.steps[0].do: Required',
    ],
    [
      'a design tool that is not supported',
      bundle(requirement({ source: { tool: 'sketch', file: 'ABC', node: '1:2', version: '1' } })),
      'requirements[0].source.tool: Invalid literal value, expected "figma"',
    ],
    [
      'a design source with no node',
      bundle(requirement({ source: { tool: 'figma', file: 'ABC', version: '1' } })),
      'requirements[0].source.node: Required',
    ],
    ['an empty owner', bundle(requirement({ owner: '' })), 'requirements[0].owner: owner must not be empty'],
    // A value of the wrong type that has a length gets one message, for its type, and no length message.
    ['a list where text belongs', bundle(requirement({ description: [] })), 'requirements[0].description: Expected string, received array'],
    ['text where a list belongs', { version: 1, requirements: '' }, 'requirements: Expected array, received string'],
    [
      'a list where a click selector belongs',
      voice({ steps: [{ do: 'click', selector: [] }] }),
      "requirements[0].assertion.steps[0].selector: a click step needs a selector, such as selector: '#delete'",
    ],
    // A list that is too short and holds a bad entry reports its length first.
    [
      'a focus order with one empty name',
      bundle(requirement({ kind: 'focus-order', assertion: { type: 'focus-order', sequence: [''] } })),
      'requirements[0].assertion.sequence: sequence needs at least two names, because one name has no order; requirements[0].assertion.sequence[0]: each sequence entry must not be empty',
    ],
  ])('refuses %s with the same message', (_, raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it('reads an infinite step number written in YAML and refuses it with the step range', () => {
    const yaml = [
      'version: 1',
      'requirements:',
      '  - id: r1',
      '    kind: voice',
      '    surface: home',
      '    description: d',
      '    approved: true',
      '    assertion:',
      '      type: voice',
      '      steps:',
      '        - do: tab',
      '      obligations:',
      '        - class: live-polite',
      '          afterStep: .inf',
      '          requiredTokens: [deleted]',
      '          mustAnnounce: true',
    ].join('\n');
    expect(normalize(yaml)).toEqual({
      ok: false,
      verdict: 'approval_required',
      reason:
        'requirements[0].assertion.obligations[0].afterStep: afterStep must be a whole number from 0 to 0, the position of a step in steps counted from 0',
    });
  });
});

describe('requirement file shape', () => {
  it('adds no field a file did not write, and keeps one written as undefined off', () => {
    const result = parseBundle(bundle(requirement({ assertion: { ...contentAssertion, expectedText: undefined } })));
    expect(result).toEqual({
      ok: true,
      bundle: {
        version: 1,
        requirements: [
          { id: 'r1', kind: 'content', surface: 'home', description: 'd', assertion: { type: 'content', selector: 'h1' }, approved: true },
        ],
      },
    });
  });

  it('keeps the extra fields of a flow step, which the flow runner reads', () => {
    const steps = [{ do: 'click', selector: '#save', note: 'kept' }, { do: 'wait', ms: 10 }];
    const result = parseBundle(bundle(requirement({ kind: 'flow', assertion: { type: 'flow', steps } })));
    expect(result.ok && result.bundle.requirements[0]?.assertion).toEqual({ type: 'flow', steps });
  });

  it('keeps a minCssPx that is not a whole number, which the rule allows', () => {
    const result = parseBundle(targetSize({ minCssPx: 24.5 }));
    expect(result.ok && result.bundle.requirements[0]?.assertion).toMatchObject({ minCssPx: 24.5 });
  });

  it('refuses a focus order one name past its limit, with one message', () => {
    const sequence = Array.from({ length: 201 }, (_, index) => `Name ${index}`);
    const reason = reasonOf(bundle(requirement({ kind: 'focus-order', assertion: { type: 'focus-order', sequence } })));
    expect(reason).toBe('requirements[0].assertion.sequence: sequence can list at most 200 names');
  });
});

describe('an oversized focus order', () => {
  // A list past its limit is refused on its length alone. Checking each entry of a very long list
  // first would cost time and memory in proportion to its length, and would write one message per
  // bad entry into the refusal.
  it('is refused on its length, with one message, however many entries it has', () => {
    const sequence = Array.from({ length: 100_000 }, () => '');
    const reason = reasonOf(bundle(requirement({ kind: 'focus-order', assertion: { type: 'focus-order', sequence } })));
    expect(reason.length).toBeLessThan(200);
    expect(reason).toBe('requirements[0].assertion.sequence: sequence can list at most 200 names');
  });
});

describe('a requirement file with too many problems to check', () => {
  // The schema library stops with an error, not a list of problems, when one list in a file holds
  // more than about 123,000 of them. The file is still refused, and the refusal says why, in place
  // of a parser message that would call valid YAML invalid.
  const TOO_MANY = 'this file has too many problems to check, so it is refused; fix the entries in its longest list, or split it into smaller files';
  const emptySteps = 150_000;

  it('is refused with a reason that says so', () => {
    const steps = Array.from({ length: emptySteps }, () => ({ do: '' }));
    expect(reasonOf(bundle(requirement({ kind: 'flow', assertion: { type: 'flow', steps } })))).toBe(TOO_MANY);
  });

  it('is refused by the loader with the file named and none of its text', async () => {
    const yaml = [
      'version: 1',
      'requirements:',
      '  - id: r1',
      '    kind: flow',
      '    surface: home',
      '    description: d',
      '    approved: true',
      '    assertion:',
      '      type: flow',
      '      steps:',
      ...Array.from({ length: emptySteps }, () => "        - do: ''"),
    ].join('\n');
    expect(yaml.length).toBeGreaterThan(2_400_000);
    const fs: FsGlob = {
      readFile: async (path) => (path === 'requirements/huge.yaml' ? yaml : null),
      glob: async () => ['requirements/huge.yaml'],
    };
    const result = await loadRequirements(fs, testConfig({ requirements: 'requirements/' }));
    expect(result).toEqual({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/huge.yaml',
      reason: `requirements path requirements/huge.yaml: ${TOO_MANY}`,
    });
  });
});
