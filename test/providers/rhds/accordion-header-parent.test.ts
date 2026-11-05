import { describe, expect, it } from 'vitest';
import { ACCORDION_SEL } from '../../../src/providers/rhds/rhds-accordion-header-parent.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { byRule, run } from './fake-page.js';

describe('rhds-accordion-header-parent', () => {
  const RULE = 'rhds-accordion-header-parent';

  it('fails an rh-accordion-header whose parent is not rh-accordion', async () => {
    const { drafts } = await run({ query: { [ACCORDION_SEL.misplacedHeader]: ['#stray'] } });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, evidenceClass: 'deterministic', confidence: 'fail', elementPath: '#stray' }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.fix).toContain('rh-accordion');
  });

  it('is silent when every header sits directly in an rh-accordion', async () => {
    expect((await run({})).drafts).toEqual([]);
  });

  it('selects a header that is not a direct child of rh-accordion', () => {
    expect(ACCORDION_SEL.misplacedHeader).toBe('rh-accordion-header:not(rh-accordion > rh-accordion-header)');
  });
});
