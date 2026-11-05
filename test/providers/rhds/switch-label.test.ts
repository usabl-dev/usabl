import { describe, expect, it } from 'vitest';
import { labelFor, SWITCH_SEL } from '../../../src/providers/rhds/rhds-switch-label.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { ax, byRule, run } from './fake-page.js';

describe('rhds-switch-label', () => {
  const RULE = 'rhds-switch-label';
  const host = '#wifi';

  it('fails an upgraded switch with no label source whose tree name is empty', async () => {
    const { drafts } = await run({ query: { [SWITCH_SEL.host]: [host] }, ax: { [host]: ax('', 'switch') } });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, evidenceClass: 'deterministic', confidence: 'fail', elementPath: host, role: 'switch' }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.fix).toContain('accessible-label');
    expect(drafts[0]?.fix).toContain('<label for>');
  });

  it('passes a switch with an accessible-label or a label pointing at its id', async () => {
    const { drafts } = await run({
      query: { [SWITCH_SEL.host]: ['#a', '#b'], [labelFor('b-switch')]: ['label:nth-child(1)'] },
      markup: {
        '#a': { attributes: { 'accessible-label': 'Wi-Fi' } },
        '#b': { attributes: { id: 'b-switch' } },
      },
    });
    expect(drafts).toEqual([]);
  });

  it('does not count a switch id that no label points at', async () => {
    const { drafts } = await run({
      query: { [SWITCH_SEL.host]: [host] },
      markup: { [host]: { attributes: { id: 'wifi' } } },
      ax: { [host]: ax(null, 'switch') },
    });
    expect(byRule(drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'fail' })]);
  });

  it('passes a switch with no markup label source when the tree names it', async () => {
    const { drafts } = await run({ query: { [SWITCH_SEL.host]: [host] }, ax: { [host]: ax('Wi-Fi', 'switch') } });
    expect(drafts).toEqual([]);
  });

  it('reports unverified when the switch has no accessibility node or never upgraded', async () => {
    const hidden = await run({ query: { [SWITCH_SEL.host]: [host] } });
    expect(byRule(hidden.drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'unverified' })]);

    const notUpgraded = await run({
      query: { [SWITCH_SEL.host]: [host] },
      markup: { [host]: { defined: false } },
      ax: { [host]: ax('', 'switch') },
    });
    expect(byRule(notUpgraded.drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'unverified' })]);
    expect(notUpgraded.drafts[0]?.why).toContain('not upgraded');
  });

  it('escapes the id in the label selector', () => {
    expect(labelFor('x"y')).toBe('label[for="x\\"y"]');
  });
});
