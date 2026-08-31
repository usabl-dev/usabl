import { describe, expect, it, vi } from 'vitest';
import type {
  AxNode,
  Draft,
  ElementRef,
  Page,
  ProfileName,
  ProviderContext,
} from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeDocsRulepackProvider } from '../../src/providers/docs-rulepack/index.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'guide', url: 'http://127.0.0.1:5173/docs/guide' };

// Must match the selector the check passes to queryAll, so the query plan resolves.
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

function element(selector: string): ElementRef {
  return { selector };
}

// A heading AX node carries its level as a numeric `states.level`, mirroring how CDP
// exposes heading depth for both native <h1>..<h6> and role="heading" aria-level.
function heading(level: number, name = `Heading ${level}`): AxNode {
  return { name, role: 'heading', states: { level } };
}

function withDocsPage(
  page: Page,
  queryPlan: Record<string, ElementRef[]>,
  axPlan: Record<string, AxNode | null>,
): Page {
  return Object.assign(page, {
    queryAll: async (selector: string) => queryPlan[selector] ?? [],
    axAt: async (selector: string) => {
      if (Object.hasOwn(axPlan, selector)) {
        return axPlan[selector] ?? null;
      }
      return null;
    },
  });
}

async function makeContext(
  headings: ElementRef[],
  axPlan: Record<string, AxNode | null> = {},
  profile?: ProfileName,
): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  return {
    page: withDocsPage(page, { [HEADING_SELECTOR]: headings }, axPlan),
    screen: SCREEN,
    config: testConfig(),
    ...(profile !== undefined ? { profile } : {}),
  };
}

function draftFrom(rule: string): Draft {
  return {
    rule,
    layer: 'docs-content',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: '.extra',
    elementName: null,
    role: null,
    whatUserExperiences: 'extra check ran',
    why: 'extra check ran',
    fix: 'extra check ran',
    evidence: {},
    confidence: 'fail',
  };
}

describe('makeDocsRulepackProvider', () => {
  it('stays silent when heading levels descend by one and repeat', async () => {
    const one = element('#h-one');
    const twoA = element('#h-two-a');
    const twoB = element('#h-two-b');
    const three = element('#h-three');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [one, twoA, twoB, three],
      {
        [one.selector]: heading(1),
        [twoA.selector]: heading(2),
        [twoB.selector]: heading(2),
        [three.selector]: heading(3),
      },
      'docs',
    );

    await expect(provider.run(ctx)).resolves.toEqual([]);
  });

  it('flags a heading that skips a level down by more than one', async () => {
    const one = element('#h-one');
    const three = element('#h-three');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [one, three],
      {
        [one.selector]: heading(1),
        [three.selector]: heading(3),
      },
      'docs',
    );

    const drafts = await provider.run(ctx);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'docs-heading-order',
      layer: 'docs-content',
      severity: 'moderate',
      evidenceClass: 'deterministic',
      elementPath: three.selector,
      confidence: 'fail',
    });
    expect(drafts[0]?.evidence.extra).toEqual({ fromLevel: 1, toLevel: 3 });
  });

  it('does not flag a heading that climbs back up to a shallower level', async () => {
    const one = element('#h-one');
    const two = element('#h-two');
    const three = element('#h-three');
    const backToTwo = element('#h-two-again');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [one, two, three, backToTwo],
      {
        [one.selector]: heading(1),
        [two.selector]: heading(2),
        [three.selector]: heading(3),
        [backToTwo.selector]: heading(2),
      },
      'docs',
    );

    await expect(provider.run(ctx)).resolves.toEqual([]);
  });

  it('skips a heading with an unreadable level without hiding a later real skip', async () => {
    const one = element('#h-one');
    const unknown = element('#h-unknown');
    const three = element('#h-three');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [one, unknown, three],
      {
        [one.selector]: heading(1),
        // Level unreadable: axAt yields null, so this heading is neither compared nor flagged.
        [unknown.selector]: null,
        [three.selector]: heading(3),
      },
      'docs',
    );

    const drafts = await provider.run(ctx);

    // The level 3 is still compared against the last KNOWN level 1, so the 1->3 skip is caught.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'docs-heading-order',
      elementPath: three.selector,
    });
    expect(drafts[0]?.evidence.extra).toEqual({ fromLevel: 1, toLevel: 3 });
  });

  it('treats a NaN level as unreadable and keeps detecting a later real skip', async () => {
    const one = element('#h-one');
    const notANumber = element('#h-nan');
    const three = element('#h-three');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [one, notANumber, three],
      {
        [one.selector]: heading(1),
        // A NaN level must not poison previousLevel. If it did, every later comparison
        // against NaN would be false and heading-order detection would go silent.
        [notANumber.selector]: heading(Number.NaN),
        [three.selector]: heading(3),
      },
      'docs',
    );

    const drafts = await provider.run(ctx);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'docs-heading-order',
      elementPath: three.selector,
    });
    expect(drafts[0]?.evidence.extra).toEqual({ fromLevel: 1, toLevel: 3 });
  });

  it('emits a draft per skip and re-anchors after a climb back up', async () => {
    const two = element('#h-two');
    const four = element('#h-four');
    const three = element('#h-three');
    const five = element('#h-five');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [two, four, three, five],
      {
        [two.selector]: heading(2),
        [four.selector]: heading(4),
        [three.selector]: heading(3),
        [five.selector]: heading(5),
      },
      'docs',
    );

    const drafts = await provider.run(ctx);

    // 2->4 skips a level. 4->3 climbs back up and re-anchors previousLevel to 3.
    // 3->5 then skips again against that re-anchored level, so two drafts emit in one page.
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.elementPath).toBe(four.selector);
    expect(drafts[0]?.evidence.extra).toEqual({ fromLevel: 2, toLevel: 4 });
    expect(drafts[1]?.elementPath).toBe(five.selector);
    expect(drafts[1]?.evidence.extra).toEqual({ fromLevel: 3, toLevel: 5 });
  });

  it('stays silent when an unreadable level sits between two equal levels', async () => {
    const twoA = element('#h-two-a');
    const unknown = element('#h-unknown');
    const twoB = element('#h-two-b');
    const provider = makeDocsRulepackProvider();
    const ctx = await makeContext(
      [twoA, unknown, twoB],
      {
        [twoA.selector]: heading(2),
        [unknown.selector]: null,
        [twoB.selector]: heading(2),
      },
      'docs',
    );

    await expect(provider.run(ctx)).resolves.toEqual([]);
  });

  it('is a no-op on the app profile and when the profile is absent, running no checks', async () => {
    const one = element('#h-one');
    const three = element('#h-three');
    const skipAxPlan = {
      [one.selector]: heading(1),
      [three.selector]: heading(3),
    };

    const appExtra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-should-not-run')]);
    const appProvider = makeDocsRulepackProvider([appExtra]);
    const appContext = await makeContext([one, three], skipAxPlan, 'app');

    await expect(appProvider.run(appContext)).resolves.toEqual([]);
    expect(appExtra).not.toHaveBeenCalled();

    const defaultExtra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-should-not-run')]);
    const defaultProvider = makeDocsRulepackProvider([defaultExtra]);
    const defaultContext = await makeContext([one, three], skipAxPlan);

    await expect(defaultProvider.run(defaultContext)).resolves.toEqual([]);
    expect(defaultExtra).not.toHaveBeenCalled();
  });

  it('runs its extra checks on the docs profile and advertises live capability', async () => {
    const extra = vi.fn(async (): Promise<Draft[]> => [draftFrom('extra-ran-docs')]);
    const provider = makeDocsRulepackProvider([extra]);
    const ctx = await makeContext([], {}, 'docs');

    const drafts = await provider.run(ctx);

    expect(extra).toHaveBeenCalledTimes(1);
    expect(drafts).toEqual([draftFrom('extra-ran-docs')]);
    expect(provider.capabilities).toContain('live');
  });
});
