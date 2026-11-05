import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../../src/contracts/index.js';
import { makeFakePage } from '../../../src/deps/fakes.js';
import { makeRhdsRulepackProvider, RHDS_MARKER } from '../../../src/providers/rhds/index.js';
import { BUTTON_SEL } from '../../../src/providers/rhds/rhds-button-accessible-label.js';
import { RHDS_RULES, RHDS_TAGS } from '../../../src/providers/rhds/sources.js';
import { applicabilityOf, draftsOf, gapsOf, testConfig } from '../../helpers.js';
import { ax, run, SCREEN } from './fake-page.js';

async function failingButtonDraft(): Promise<Draft> {
  const { drafts } = await run({
    query: { [BUTTON_SEL.host]: ['#x'] },
    shadow: { '#x': { [BUTTON_SEL.inner]: ax('', 'button') } },
  });
  const [draft] = drafts;
  if (draft === undefined) throw new Error('expected a draft');
  return draft;
}

describe('makeRhdsRulepackProvider', () => {
  it('declares its id, layer, and capability, and never touches page state', () => {
    const provider = makeRhdsRulepackProvider();
    expect(provider.id).toBe('rhds-rulepack');
    expect(provider.layer).toBe('rhds');
    expect(provider.capabilities).toEqual(['live']);
    expect(provider.mutatesPageState).not.toBe(true);
  });

  it('marks the page with every RHDS tag and nothing else', () => {
    expect(RHDS_MARKER).toBe(RHDS_TAGS.join(', '));
    expect(RHDS_MARKER.split(', ')).toContain('rh-button');
  });

  it('reports every rule inapplicable, with no drafts and no gaps, on a page with no RHDS element', async () => {
    for (const profile of [undefined, 'app', 'docs'] as const) {
      const result = await run({ markers: 0, query: { [BUTTON_SEL.host]: ['#x'] }, shadow: { '#x': { [BUTTON_SEL.inner]: ax('', 'button') } } }, profile);
      expect(result.drafts).toEqual([]);
      expect(result.gaps).toEqual([]);
      expect(result.applicability).toEqual(
        RHDS_RULES.map((rule) => ({ screenId: SCREEN.id, layer: 'rhds', rule, outcome: 'inapplicable', elementCount: 0 })),
      );
    }
  });

  it('runs no check on a page with no RHDS element', async () => {
    const extra = vi.fn(async (): Promise<Draft[]> => []);
    const page = makeFakePage();
    await makeRhdsRulepackProvider([extra]).run({ page, screen: SCREEN, config: testConfig() });
    expect(extra).not.toHaveBeenCalled();
  });

  it('runs on the app and docs profiles when RHDS is on the page', async () => {
    const plan = { query: { [BUTTON_SEL.host]: ['#x'] }, shadow: { '#x': { [BUTTON_SEL.inner]: ax('', 'button') } } };
    for (const profile of [undefined, 'app', 'docs'] as const) {
      const result = await run(plan, profile);
      expect(result.drafts.map((draft) => draft.rule)).toEqual(['rhds-button-accessible-label']);
      expect(result.applicability).toEqual([]);
    }
  });

  it('turns a check that throws into a named gap and keeps the other checks', async () => {
    const page = makeFakePage({
      countEverywhere: async (selector) => (selector === RHDS_MARKER ? 1 : 0),
      queryAll: async (selector) => {
        if (selector === BUTTON_SEL.host) throw new Error('boom');
        return [];
      },
    });
    const later = async (): Promise<Draft[]> => [{ ...(await failingButtonDraft()), rule: 'later-check' }];
    const output = await makeRhdsRulepackProvider([later]).run({ page, screen: SCREEN, config: testConfig() });

    expect(gapsOf(output)).toEqual([
      {
        ref: 'provider:rhds-rulepack/rhds-button-accessible-label',
        state: 'not-covered',
        reason: 'rhds rulepack check rhds-button-accessible-label failed: boom',
      },
    ]);
    expect(draftsOf(output).map((draft) => draft.rule)).toEqual(['later-check']);
    expect(applicabilityOf(output)).toEqual([]);
  });

  it('lets a marker read that throws reach the provider runner, which discloses it as a gap', async () => {
    const page = makeFakePage({
      countEverywhere: async () => {
        throw new Error('page closed');
      },
    });
    await expect(makeRhdsRulepackProvider().run({ page, screen: SCREEN, config: testConfig() })).rejects.toThrow('page closed');
  });
});
