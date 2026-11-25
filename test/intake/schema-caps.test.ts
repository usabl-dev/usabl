import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/intake/normalize.js';
import { parseBundle } from '../../src/intake/schema.js';

// A refusal lists at most 100 problems and then says how many more there are, and an unknown-key
// message names at most five keys, each cut to 60 characters after secrets are taken out. So a
// file within every limit can never build a refusal of millions of messages.

function requirement(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    kind: 'content',
    surface: 'home',
    description: 'd',
    assertion: { type: 'content', selector: 'h1' },
    approved: true,
    ...over,
  };
}

function bundle(entry: unknown): unknown {
  return { version: 1, requirements: [entry] };
}

function emptySteps(count: number): unknown {
  const steps = Array.from({ length: count }, () => ({ do: '' }));
  return bundle(requirement({ kind: 'flow', assertion: { type: 'flow', steps } }));
}

function reasonOf(raw: unknown): string {
  const result = parseBundle(raw);
  if (result.ok) {
    throw new Error('expected the bundle to be refused');
  }
  expect(result.verdict).toBe('approval_required');
  return result.reason;
}

const stepProblems = (count: number): string =>
  Array.from({ length: count }, (_, index) => `requirements[0].assertion.steps[${index}].do: steps[].do is required`).join('; ');

describe('the problem cap of a refusal', () => {
  it('lists every problem up to 100', () => {
    expect(reasonOf(emptySteps(100))).toBe(stepProblems(100));
  });

  it('lists the first 100 problems and counts the rest', () => {
    expect(reasonOf(emptySteps(101))).toBe(`${stepProblems(100)}; and 1 more problem`);
    expect(reasonOf(emptySteps(1000))).toBe(`${stepProblems(100)}; and 900 more problems`);
  });

  // The densest bad file the list limits allow: 100 empty obligations in each requirement, about
  // 1.1 problems for each byte. One just under the byte limit holds about 140,000 problems.
  it('refuses the worst file just under the byte limit within 2 seconds and 256 MB', () => {
    const line = `  - {kind: voice, assertion: {type: voice, steps: [], obligations: [${Array(100).fill('{}').join(',')}]}}\n`;
    let yaml = 'version: 1\nrequirements:\n';
    while (Buffer.byteLength(yaml) + line.length <= 128 * 1024) {
      yaml += line;
    }
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = normalize(yaml);
    const elapsedMs = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    if (result.ok) throw new Error('expected the file to be refused');
    expect(result.reason).toMatch(/; and 142,8\d\d more problems$/u);
    expect(result.reason.split('; requirements[').length).toBeLessThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(2000);
    expect(heapGrowth).toBeLessThan(256 * 1024 * 1024);
  }, 60_000);
});

describe('the unknown-key list of a message', () => {
  const extra = (count: number, name = (index: number) => `k${index}`) =>
    requirement(Object.fromEntries(Array.from({ length: count }, (_, index) => [name(index), 1])));

  it('names up to five unknown keys', () => {
    expect(reasonOf(bundle(extra(5)))).toBe("requirements[0]: Unrecognized key(s) in object: 'k0', 'k1', 'k2', 'k3', 'k4'");
  });

  it('names the first five and counts the rest', () => {
    expect(reasonOf(bundle(extra(6)))).toBe(
      "requirements[0]: Unrecognized key(s) in object: 'k0', 'k1', 'k2', 'k3', 'k4', and 1 more",
    );
    expect(reasonOf(bundle(extra(2000)))).toBe(
      "requirements[0]: Unrecognized key(s) in object: 'k0', 'k1', 'k2', 'k3', 'k4', and 1,995 more",
    );
  });

  it('cuts a long key name to 60 characters', () => {
    expect(reasonOf(bundle(extra(1, () => 'a'.repeat(5000))))).toBe(
      `requirements[0]: Unrecognized key(s) in object: '${'a'.repeat(60)}...'`,
    );
  });

  it('takes a secret out of a key name before it cuts the name', () => {
    const name = `${'a'.repeat(50)} token=SECRETPOISON`;
    const reason = reasonOf(bundle(extra(1, () => name)));
    expect(reason).not.toContain('SECRET');
    expect(reason).toBe(`requirements[0]: Unrecognized key(s) in object: '${`${'a'.repeat(50)} token=[REDACTED]`.slice(0, 60)}...'`);
  });

  it('names at most five unknown fields of a voice step', () => {
    const step = { do: 'tab', ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`f${index}`, 1])) };
    const raw = bundle(
      requirement({
        kind: 'voice',
        assertion: {
          type: 'voice',
          steps: [step],
          obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['saved'], mustAnnounce: true }],
        },
      }),
    );
    expect(reasonOf(raw)).toBe(
      'requirements[0].assertion.steps[0]: f0, f1, f2, f3, f4, and 2 more is not a field of a tab step; write only do: tab',
    );
  });
});
