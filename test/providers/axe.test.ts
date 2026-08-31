import { describe, expect, it } from 'vitest';
import type { Page, ProfileName, ProviderContext } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { AxeIssue } from '../../src/providers/axe/index.js';
import { applyAxeTags, axeProvider, DOCS_AXE_TAGS } from '../../src/providers/axe/index.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

type RunAxeOptions = { tags?: readonly string[] } | undefined;

interface AxeResult {
  violations: AxeIssue[];
  incomplete: AxeIssue[];
}

function withRunAxe(page: Page, result: AxeResult): Page & { runAxe: () => Promise<AxeResult> } {
  return Object.assign(page, {
    runAxe: async () => result,
  });
}

// Records the options each runAxe call received so tests can prove app vs docs axe wiring.
function withRecordingRunAxe(
  page: Page,
  calls: RunAxeOptions[],
): Page & { runAxe: (options?: RunAxeOptions) => Promise<AxeResult> } {
  return Object.assign(page, {
    runAxe: async (options?: RunAxeOptions) => {
      calls.push(options);
      return { violations: [], incomplete: [] };
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

async function makeContext(result: AxeResult): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withRunAxe(page, result),
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

describe('axeProvider', () => {
  it('maps one violation node to one fail Draft', async () => {
    const ctx = await makeContext({ violations: [VIOLATION], incomplete: [] });

    const drafts = await axeProvider.run(ctx);

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

  it('maps incomplete findings as unverified and never drops them', async () => {
    const ctx = await makeContext({ violations: [], incomplete: [VIOLATION] });

    const drafts = await axeProvider.run(ctx);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'button-name',
      confidence: 'unverified',
      whatUserExperiences: `Needs review: ${VIOLATION.description}`,
    });
  });

  it('returns empty drafts for a clean page and advertises live capability', async () => {
    const ctx = await makeContext({ violations: [], incomplete: [] });

    const drafts = await axeProvider.run(ctx);

    expect(drafts).toEqual([]);
    expect(axeProvider.capabilities).toContain('live');
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
