import { describe, expect, it } from 'vitest';
import type { Page, ProfileName, ProviderContext } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { AxeIssue, AxeRunResult, AxeRuleSummary } from '../../src/providers/axe/index.js';
import { applyAxeTags, axeProvider, DOCS_AXE_TAGS } from '../../src/providers/axe/index.js';
import { applicabilityOf, draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

type RunAxeOptions = { tags?: readonly string[] } | undefined;

const EMPTY_AXE_RESULT: AxeRunResult = {
  violations: [],
  incomplete: [],
  passes: [],
  inapplicable: [],
};

function axeResult(parts: Partial<AxeRunResult>): AxeRunResult {
  return { ...EMPTY_AXE_RESULT, ...parts };
}

function withRunAxe(page: Page, result: AxeRunResult): Page & { runAxe: () => Promise<AxeRunResult> } {
  return Object.assign(page, {
    runAxe: async () => result,
  });
}

// Records the options each runAxe call received so tests can prove app vs docs axe wiring.
function withRecordingRunAxe(
  page: Page,
  calls: RunAxeOptions[],
): Page & { runAxe: (options?: RunAxeOptions) => Promise<AxeRunResult> } {
  return Object.assign(page, {
    runAxe: async (options?: RunAxeOptions) => {
      calls.push(options);
      return EMPTY_AXE_RESULT;
    },
  });
}

async function makeRecordingContext(
  calls: RunAxeOptions[],
  profile?: ProfileName,
): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRecordingRunAxe(page, calls),
    screen: SCREEN,
    config: testConfig(),
    ...(profile !== undefined ? { profile } : {}),
  };
}

async function makeContext(result: Partial<AxeRunResult>): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRunAxe(page, axeResult(result)),
    screen: SCREEN,
    config: testConfig(),
  };
}

async function makeContextWithoutAxe(): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  return {
    page: await deps.browser.open(SCREEN.url),
    screen: SCREEN,
    config: testConfig(),
  };
}

const VIOLATION: AxeIssue = {
  id: 'button-name',
  impact: 'serious',
  description: 'Buttons need an accessible name so assistive tech can identify their action.',
  nodes: [
    {
      target: ['.pf-v6-c-button.pf-m-plain'],
      html: '<button class="pf-v6-c-button pf-m-plain"></button>',
      failureSummary: 'Fix any of the following: element does not have inner text or an aria-label.',
      any: [{ data: { expected: 'aria-label or visible text' } }],
    },
  ],
};

// A second issue with two nodes, so elementCount cannot pass by always being one.
const INCOMPLETE_ISSUE: AxeIssue = {
  id: 'color-contrast',
  impact: 'serious',
  description: 'Text needs enough contrast against its background to be readable.',
  nodes: [{ target: ['.header'] }, { target: ['.footer'] }],
};

const PASSED_RULE: AxeRuleSummary = { id: 'html-has-lang', nodeCount: 1 };

const INAPPLICABLE_RULE: AxeRuleSummary = { id: 'video-caption', nodeCount: 0 };

describe('axeProvider', () => {
  it('maps one violation node to one fail Draft', async () => {
    const ctx = await makeContext({ violations: [VIOLATION] });

    const drafts = draftsOf(await axeProvider.run(ctx));

    expect(drafts).toHaveLength(1);
    const first = drafts[0];
    expect(first).toMatchObject({
      rule: 'button-name',
      layer: 'axe',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      screenId: SCREEN.id,
      elementPath: '.pf-v6-c-button.pf-m-plain',
      severity: 'serious',
    });
    expect(first?.why).toBeTruthy();
    expect(first?.fix).toBeTruthy();
    expect(first?.evidence.extra).toMatchObject({
      html: '<button class="pf-v6-c-button pf-m-plain"></button>',
      axeData: { expected: 'aria-label or visible text' },
    });
  });

  it('keeps the element path as before and carries the target parts of an element past a boundary', async () => {
    const shadow: AxeIssue = {
      ...VIOLATION,
      nodes: [{ target: ['x-row-actions,button'], targetParts: [['x-row-actions', 'button']] }, { target: ['.plain'] }],
    };
    const drafts = draftsOf(await axeProvider.run(await makeContext({ violations: [shadow] })));
    expect(drafts.map((d) => d.elementPath)).toEqual(['x-row-actions,button', '.plain']);
    expect(drafts[0]?.evidence.extra?.['rowTarget']).toEqual([['x-row-actions', 'button']]);
    expect(drafts[1]?.evidence).toEqual({});
  });

  it('maps incomplete findings as unverified and never drops them', async () => {
    const ctx = await makeContext({ incomplete: [VIOLATION] });

    const drafts = draftsOf(await axeProvider.run(ctx));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'button-name',
      confidence: 'unverified',
      whatUserExperiences: `Needs review: ${VIOLATION.description}`,
    });
  });

  it('returns empty drafts for a clean page and advertises live capability', async () => {
    const ctx = await makeContext({});

    const drafts = draftsOf(await axeProvider.run(ctx));

    expect(drafts).toEqual([]);
    expect(axeProvider.capabilities).toContain('live');
  });

  it('records one applicability entry per rule for all four axe outcomes', async () => {
    const ctx = await makeContext({
      violations: [VIOLATION],
      incomplete: [INCOMPLETE_ISSUE],
      passes: [PASSED_RULE],
      inapplicable: [INAPPLICABLE_RULE],
    });

    const applicability = applicabilityOf(await axeProvider.run(ctx));

    expect(applicability).toEqual([
      { screenId: SCREEN.id, layer: 'axe', rule: 'button-name', outcome: 'failed', elementCount: 1 },
      { screenId: SCREEN.id, layer: 'axe', rule: 'color-contrast', outcome: 'incomplete', elementCount: 2 },
      { screenId: SCREEN.id, layer: 'axe', rule: 'html-has-lang', outcome: 'passed', elementCount: 1 },
      { screenId: SCREEN.id, layer: 'axe', rule: 'video-caption', outcome: 'inapplicable', elementCount: 0 },
    ]);
  });

  it('records what axe checked on a page that produced no drafts', async () => {
    // Silence from a rule that matched nothing and silence from a rule that matched and passed
    // are different facts, and a clean page is exactly where they are indistinguishable today.
    const ctx = await makeContext({ passes: [PASSED_RULE], inapplicable: [INAPPLICABLE_RULE] });

    const output = await axeProvider.run(ctx);

    expect(draftsOf(output)).toEqual([]);
    expect(applicabilityOf(output).map((entry) => [entry.rule, entry.outcome, entry.elementCount])).toEqual([
      ['html-has-lang', 'passed', 1],
      ['video-caption', 'inapplicable', 0],
    ]);
  });

  it('throws when the page does not provide runAxe', async () => {
    const ctx = await makeContextWithoutAxe();

    await expect(axeProvider.run(ctx)).rejects.toThrow('axe provider requires page.runAxe()');
  });

  it('runs axe with the docs WCAG 2.2 AA tags when the profile is docs', async () => {
    const calls: RunAxeOptions[] = [];
    const ctx = await makeRecordingContext(calls, 'docs');

    await axeProvider.run(ctx);

    expect(calls).toEqual([{ tags: DOCS_AXE_TAGS }]);
    // Cumulative WCAG: 2.2 AA must carry Level A and AA from 2.0, 2.1, and 2.2.
    expect(DOCS_AXE_TAGS).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });

  it('runs axe with no options when the profile is app so app behavior is unchanged', async () => {
    const calls: RunAxeOptions[] = [];
    const ctx = await makeRecordingContext(calls, 'app');

    await axeProvider.run(ctx);

    expect(calls).toEqual([undefined]);
  });

  it('runs axe with no options when the profile is absent so app behavior is unchanged', async () => {
    const calls: RunAxeOptions[] = [];
    const ctx = await makeRecordingContext(calls);

    await axeProvider.run(ctx);

    expect(calls).toEqual([undefined]);
  });
});

// A fake AxeBuilder that records withTags calls without pulling in playwright or @axe-core.
interface FakeBuilder {
  calls: string[][];
  withTags(tags: string[]): FakeBuilder;
}

function makeFakeBuilder(): FakeBuilder {
  const calls: string[][] = [];
  const builder: FakeBuilder = {
    calls,
    withTags(tags: string[]): FakeBuilder {
      calls.push(tags);
      return builder;
    },
  };
  return builder;
}

describe('applyAxeTags', () => {
  it('applies tags as a fresh copy when tags are present', () => {
    const builder = makeFakeBuilder();

    const result = applyAxeTags(builder, { tags: DOCS_AXE_TAGS });

    expect(result).toBe(builder);
    expect(builder.calls).toHaveLength(1);
    expect(builder.calls[0]).toEqual([...DOCS_AXE_TAGS]);
    // withTags must receive a copy, never the readonly DOCS_AXE_TAGS reference.
    expect(builder.calls[0]).not.toBe(DOCS_AXE_TAGS as unknown as string[]);
  });

  it('keeps axe defaults when no options are passed so the app path is unchanged', () => {
    const builder = makeFakeBuilder();

    const result = applyAxeTags(builder);

    expect(result).toBe(builder);
    expect(builder.calls).toHaveLength(0);
  });

  it('treats an empty tag array as no tags to avoid a false clean', () => {
    const builder = makeFakeBuilder();

    const result = applyAxeTags(builder, { tags: [] });

    expect(result).toBe(builder);
    expect(builder.calls).toHaveLength(0);
  });
});

describe('axe provider and a gradient background', () => {
  const contrastIssue = (messageKey: string): AxeIssue => ({
    id: 'color-contrast',
    impact: 'serious',
    description: 'Elements must meet minimum color contrast ratio thresholds',
    nodes: [{ target: ['.pf-v6-c-button'], any: [{ data: { messageKey } }] }],
  });

  it('says why axe could not measure and what a person should check', async () => {
    const drafts = draftsOf(await axeProvider.run(await makeContext({ incomplete: [contrastIssue('bgGradient')] })));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'color-contrast',
      layer: 'axe',
      severity: 'serious',
      elementPath: '.pf-v6-c-button',
      confidence: 'unverified',
      evidence: { extra: { axeData: { messageKey: 'bgGradient' } } },
    });
    expect(drafts[0]?.whatUserExperiences).toBe(
      'Needs review: axe could not measure the color contrast, because the background is a gradient.',
    );
    expect(drafts[0]?.why).toContain('A gradient has many');
    expect(drafts[0]?.fix).toContain('lightest and the darkest part of the gradient');
  });

  it('keeps the usual wording for any other contrast result axe could not finish', async () => {
    const drafts = draftsOf(await axeProvider.run(await makeContext({ incomplete: [contrastIssue('bgImage')] })));

    expect(drafts[0]?.whatUserExperiences).toBe('Needs review: Elements must meet minimum color contrast ratio thresholds');
  });
});
