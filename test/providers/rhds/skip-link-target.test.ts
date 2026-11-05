import { describe, expect, it } from 'vitest';
import { SKIP_LINK_SEL, targetOf } from '../../../src/providers/rhds/rhds-skip-link-target.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { byRule, run } from './fake-page.js';

describe('rhds-skip-link-target', () => {
  const RULE = 'rhds-skip-link-target';

  it('fails a skip link with no href and no slotted link', async () => {
    const { drafts } = await run({ query: { [SKIP_LINK_SEL.missingLink]: ['#skip'] } });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, evidenceClass: 'deterministic', confidence: 'fail', elementPath: '#skip' }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.fix).toContain('href');
  });

  it('fails a skip link whose fragment names no element, and keeps the page text out of the draft', async () => {
    const { drafts } = await run({
      query: { [SKIP_LINK_SEL.fragmentHref]: ['#skip'] },
      markup: { '#skip': { attributes: { href: '#main-secret-value' } } },
    });

    expect(byRule(drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'fail', elementPath: '#skip' })]);
    expect(JSON.stringify(drafts)).not.toContain('main-secret-value');
  });

  it('fails a skip link whose href is a bare #', async () => {
    const { drafts } = await run({
      query: { [SKIP_LINK_SEL.fragmentHref]: ['#skip'] },
      markup: { '#skip': { attributes: { href: '#' } } },
    });
    expect(byRule(drafts, RULE)).toHaveLength(1);
  });

  it('passes a skip link whose fragment names an element by id or an anchor by name', async () => {
    const { drafts } = await run({
      query: { [SKIP_LINK_SEL.fragmentHref]: ['#skip', '#skip-2'], [targetOf('main-content')]: ['#main-content'], [targetOf('top')]: ['a:nth-child(1)'] },
      markup: { '#skip': { attributes: { href: '#main-content' } }, '#skip-2': { attributes: { href: '#top' } } },
    });
    expect(drafts).toEqual([]);
  });

  it('finds a percent-encoded fragment by its decoded id, as fragment navigation does', async () => {
    const { drafts } = await run({
      query: { [SKIP_LINK_SEL.fragmentHref]: ['#skip'], [targetOf('main content')]: ['main:nth-child(2)'] },
      markup: { '#skip': { attributes: { href: '#main%20content' } } },
    });
    expect(drafts).toEqual([]);
  });

  it('does not check an href that is not a fragment', () => {
    expect(SKIP_LINK_SEL.fragmentHref).toBe('rh-skip-link[href^="#"]');
    // An empty href renders no link, and slot="" is the default slot.
    expect(SKIP_LINK_SEL.missingLink).toBe('rh-skip-link:is(:not([href]), [href=""]):not(:has(> a:is(:not([slot]), [slot=""])))');
    expect(targetOf('m"x')).toBe('[id="m\\"x"], a[name="m\\"x"]');
  });
});
