import { describe, expect, it } from 'vitest';
import { BUTTON_SEL } from '../../../src/providers/rhds/rhds-button-accessible-label.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { ax, byRule, run } from './fake-page.js';

describe('rhds-button-accessible-label', () => {
  const RULE = 'rhds-button-accessible-label';
  const host = '#icon-only';

  it('fails an upgraded rh-button with no label whose inner button has an empty name', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: [host] },
      shadow: { [host]: { [BUTTON_SEL.inner]: ax('', 'button') } },
    });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({
        rule: RULE,
        layer: 'rhds',
        evidenceClass: 'deterministic',
        confidence: 'fail',
        elementPath: host,
        role: 'button',
        elementName: null,
      }),
    ]);
    const [draft] = drafts;
    expect(draft?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(draft?.fix).toContain('accessible-label');
    expect(draft?.evidence.name).toEqual({ value: '', source: 'ax-tree', fromTree: true });
  });

  it('passes buttons whose markup has a name source from slotted text or a label', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: ['#save', '#labelled'] },
      markup: {
        '#save': { defaultSlotText: 'Save' },
        '#labelled': { attributes: { 'accessible-label': 'Close dialog' } },
      },
      shadow: {
        '#save': { [BUTTON_SEL.inner]: ax('Save', 'button') },
        '#labelled': { [BUTTON_SEL.inner]: ax('Close dialog', 'button') },
      },
    });

    expect(drafts).toEqual([]);
  });

  it('passes a button with no name source in markup when the tree still names its inner button', async () => {
    // The close and play variants render their own hidden text, so the tree has a name the markup
    // does not show. The tree decides, and a named button is not a barrier.
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: ['#close'] },
      markup: { '#close': { attributes: { variant: 'close' } } },
      shadow: { '#close': { [BUTTON_SEL.inner]: ax('Close', 'button') } },
    });

    expect(drafts).toEqual([]);
  });

  it('skips a button with default-slot text even when the tree cannot read it, as in a closed dialog', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: ['#confirm'] },
      markup: { '#confirm': { defaultSlotText: 'Confirm', attributes: { slot: 'footer' } } },
    });

    expect(drafts).toEqual([]);
  });

  it('reports unverified, never fail, when a button with no name source has no accessibility node', async () => {
    const { drafts } = await run({ query: { [BUTTON_SEL.host]: [host] } });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, confidence: 'unverified', elementPath: host }),
    ]);
  });

  it('reports unverified for an rh-button with no name source that never upgraded', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: [host] },
      markup: { [host]: { defined: false } },
      shadow: { [host]: { [BUTTON_SEL.inner]: ax('', 'button') } },
    });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, confidence: 'unverified', elementPath: host }),
    ]);
    expect(drafts[0]?.why).toContain('not upgraded');
  });

  it('skips an rh-button with a label even when it never upgraded', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: [host] },
      markup: { [host]: { defined: false, attributes: { 'accessible-label': 'Play video' } } },
    });

    expect(drafts).toEqual([]);
  });

  it('does not treat a blank accessible-label as a label', async () => {
    const { drafts } = await run({
      query: { [BUTTON_SEL.host]: [host] },
      markup: { [host]: { attributes: { 'accessible-label': '   ' } } },
      shadow: { [host]: { [BUTTON_SEL.inner]: ax('', 'button') } },
    });

    expect(byRule(drafts, RULE)).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('fail');
  });

  it('skips an element the query found but the markup read can no longer find', async () => {
    const { drafts } = await run({ query: { [BUTTON_SEL.host]: [host] }, markup: { [host]: null } });

    expect(drafts).toEqual([]);
  });
});
