import { describe, expect, it } from 'vitest';
import { CTA_SEL } from '../../../src/providers/rhds/rhds-cta-link.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { byRule, run } from './fake-page.js';

describe('rhds-cta-link', () => {
  const RULE = 'rhds-cta-link';

  it('fails an rh-cta with no href and no slotted link or button as its first child', async () => {
    const { drafts } = await run({ query: { [CTA_SEL.missingTarget]: ['#bare'] } });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({
        rule: RULE,
        layer: 'rhds',
        evidenceClass: 'deterministic',
        confidence: 'fail',
        elementPath: '#bare',
        elementName: null,
        role: null,
      }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.why).toContain(RHDS_SOURCES[RULE][1].quote);
    expect(drafts[0]?.fix).toContain('href');
  });

  it('is silent when no rh-cta lacks a target', async () => {
    expect(byRule((await run({})).drafts, RULE)).toEqual([]);
  });

  it('selects only a cta with no href and no a or button first child in the default slot', () => {
    // A slotted child with a slot attribute is not in the default slot, so it does not count.
    expect(CTA_SEL.missingTarget).toBe('rh-cta:not([href]):not(:has(> :is(a, button):not([slot]):first-child))');
  });
});
