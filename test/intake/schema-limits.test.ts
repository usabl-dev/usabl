import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/intake/normalize.js';
import { parseBundle } from '../../src/intake/schema.js';

// Every list in a requirement file has a size limit far above what a real file holds. A list past
// its limit is refused on its length alone, before any entry is read, so a huge file is refused
// fast and with one message. These tests pin each limit, its message, and that a list exactly at
// its limit still loads.

function requirement(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `r${index}`,
    kind: 'content',
    surface: 'home',
    description: 'd',
    assertion: { type: 'content', selector: 'h1' },
    approved: true,
    ...over,
  };
}

function bundle(requirements: unknown[]): unknown {
  return { version: 1, requirements };
}

function flow(steps: unknown[]): unknown {
  return bundle([requirement(0, { kind: 'flow', assertion: { type: 'flow', steps } })]);
}

const goodObligation = { class: 'live-polite', afterStep: 0, requiredTokens: ['saved'], mustAnnounce: true };

function voice(steps: unknown[], obligations: unknown[]): unknown {
  return bundle([requirement(0, { kind: 'voice', assertion: { type: 'voice', steps, obligations } })]);
}

function many<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

function reasonOf(raw: unknown): string {
  const result = parseBundle(raw);
  if (result.ok) {
    throw new Error('expected the bundle to be refused');
  }
  expect(result.verdict).toBe('approval_required');
  return result.reason;
}

function accepted(raw: unknown): boolean {
  const result = parseBundle(raw);
  if (!result.ok) {
    throw new Error(`expected the bundle to load: ${result.reason.slice(0, 300)}`);
  }
  return true;
}

const REQUIREMENTS_LIMIT = 'requirements: requirements can list at most 1,000 requirements; put the rest in another file';
const FLOW_STEPS_LIMIT = 'requirements[0].assertion.steps: flow steps can list at most 1,000 steps';
const FLOW_STEP_FIELDS_LIMIT = 'requirements[0].assertion.steps[0]: a flow step can have at most 100 fields';
const VOICE_STEPS_LIMIT = 'requirements[0].assertion.steps: voice steps can list at most 1,000 steps';
const OBLIGATIONS_LIMIT = 'requirements[0].assertion.obligations: voice obligations can list at most 100 obligations';
const TOKENS_LIMIT = 'requirements[0].assertion.obligations[0].requiredTokens: requiredTokens can list at most 100 words';

describe('the size limits of a requirement file', () => {
  it('loads 1,000 requirements in one file and refuses 1,001', () => {
    expect(accepted(bundle(many(1000, (index) => requirement(index))))).toBe(true);
    expect(reasonOf(bundle(many(1001, (index) => requirement(index))))).toBe(REQUIREMENTS_LIMIT);
  });

  it('loads 1,000 steps in one flow and refuses 1,001', () => {
    expect(accepted(flow(many(1000, () => ({ do: 'tab' }))))).toBe(true);
    expect(reasonOf(flow(many(1001, () => ({ do: 'tab' }))))).toBe(FLOW_STEPS_LIMIT);
  });

  it('loads a flow step with 100 fields and refuses one with 101', () => {
    const fields = (count: number) => ({ do: 'click', ...Object.fromEntries(many(count - 1, (index) => [`field${index}`, 'x'])) });
    expect(accepted(flow([fields(100)]))).toBe(true);
    expect(reasonOf(flow([fields(101)]))).toBe(FLOW_STEP_FIELDS_LIMIT);
  });

  it('loads 1,000 steps in one voice contract and refuses 1,001', () => {
    expect(accepted(voice(many(1000, () => ({ do: 'tab' })), [goodObligation]))).toBe(true);
    expect(reasonOf(voice(many(1001, () => ({ do: 'tab' })), [goodObligation]))).toBe(VOICE_STEPS_LIMIT);
  });

  it('loads 100 obligations in one voice contract and refuses 101', () => {
    expect(accepted(voice([{ do: 'tab' }], many(100, () => goodObligation)))).toBe(true);
    expect(reasonOf(voice([{ do: 'tab' }], many(101, () => goodObligation)))).toBe(OBLIGATIONS_LIMIT);
  });

  it('loads 100 requiredTokens in one obligation and refuses 101', () => {
    const tokens = (count: number) => [{ ...goodObligation, requiredTokens: many(count, (index) => `word${index}`) }];
    expect(accepted(voice([{ do: 'tab' }], tokens(100)))).toBe(true);
    expect(reasonOf(voice([{ do: 'tab' }], tokens(101)))).toBe(TOKENS_LIMIT);
  });

  // A list past its limit gets one message, whatever its entries hold. Reading the entries first
  // would add one message for each bad one.
  it.each([
    ['requirements', bundle(many(1001, () => ({}))), REQUIREMENTS_LIMIT],
    ['flow steps', flow(many(1001, () => ({ do: '' }))), FLOW_STEPS_LIMIT],
    ['flow step fields', flow([Object.fromEntries(many(101, (index) => [`field${index}`, 'x']))]), FLOW_STEP_FIELDS_LIMIT],
    ['voice steps', voice(many(1001, () => ({ do: 'jump' })), [goodObligation]), VOICE_STEPS_LIMIT],
    ['voice obligations', voice([{ do: 'tab' }], many(101, () => ({}))), OBLIGATIONS_LIMIT],
    ['requiredTokens', voice([{ do: 'tab' }], [{ ...goodObligation, requiredTokens: many(101, () => 1) }]), TOKENS_LIMIT],
  ])('refuses %s past the limit with one message, before it reads an entry', (_, raw, message) => {
    expect(reasonOf(raw)).toBe(message);
  });

  it('names the limit and quotes no file text when the file is read from YAML', () => {
    const yaml = [
      'version: 1',
      'requirements:',
      ...many(1001, (index) => `  - { id: secret-name-${index}, kind: content, surface: home }`),
    ].join('\n');
    const result = normalize(yaml);
    expect(result).toEqual({ ok: false, verdict: 'approval_required', reason: REQUIREMENTS_LIMIT });
  });
});

describe('a requirement file with 200,000 requirements', () => {
  // Without a limit, each entry was checked, and the refusal held about 1.2 million messages. That
  // took about 9 seconds and over 1 GB of memory on the build machine.
  it('is refused in well under a second, with little memory and one message', () => {
    const raw = bundle(many(200_000, () => ({})));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const reason = reasonOf(raw);
    const elapsedMs = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(reason).toBe(REQUIREMENTS_LIMIT);
    expect(elapsedMs).toBeLessThan(250);
    expect(heapGrowth).toBeLessThan(32 * 1024 * 1024);
  }, 60_000);
});
