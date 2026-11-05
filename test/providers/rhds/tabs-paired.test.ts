import { describe, expect, it } from 'vitest';
import { panelsIn, TABS_SEL, tabsIn } from '../../../src/providers/rhds/rhds-tabs-paired.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { byRule, run } from './fake-page.js';

describe('rhds-tabs-paired', () => {
  const RULE = 'rhds-tabs-paired';

  it('fails an rh-tabs whose tab count differs from its panel count', async () => {
    const { drafts } = await run({
      query: {
        [TABS_SEL.host]: ['#tabs'],
        [tabsIn('#tabs')]: ['#t1', '#t2', '#t3'],
        [panelsIn('#tabs')]: ['#p1', '#p2'],
      },
    });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, evidenceClass: 'deterministic', confidence: 'fail', elementPath: '#tabs' }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.why).toContain('3 rh-tab');
    expect(drafts[0]?.why).toContain('2 rh-tab-panel');
    expect(drafts[0]?.fix).toContain('rh-tab-panel');
  });

  it('passes an rh-tabs with one panel per tab, and counts each tab set on its own', async () => {
    const { drafts } = await run({
      query: {
        [TABS_SEL.host]: ['#outer', '#inner'],
        [tabsIn('#outer')]: ['#o1', '#o2'],
        [panelsIn('#outer')]: ['#op1', '#op2'],
        [tabsIn('#inner')]: ['#i1'],
        [panelsIn('#inner')]: ['#ip1'],
      },
    });

    expect(drafts).toEqual([]);
  });

  it('counts direct children only: tabs in the tab slot, panels in the default slot', () => {
    expect(tabsIn('#tabs')).toBe('#tabs > rh-tab[slot="tab"]');
    expect(panelsIn('#tabs')).toBe('#tabs > rh-tab-panel:not([slot])');
  });
});
