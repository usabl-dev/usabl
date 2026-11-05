import { describe, expect, it } from 'vitest';
import { DIALOG_SEL, headingsIn, triggerOf } from '../../../src/providers/rhds/rhds-dialog-name.js';
import { RHDS_SOURCES } from '../../../src/providers/rhds/sources.js';
import { ax, byRule, run } from './fake-page.js';

describe('rhds-dialog-name', () => {
  const RULE = 'rhds-dialog-name';
  const host = '#dialog';

  it('fails an open dialog with no label, no heading, and no trigger text whose tree name is empty', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host] },
      shadow: { [host]: { [DIALOG_SEL.inner]: ax('', 'dialog') } },
    });

    expect(byRule(drafts, RULE)).toEqual([
      expect.objectContaining({ rule: RULE, evidenceClass: 'deterministic', confidence: 'fail', elementPath: host, role: 'dialog' }),
    ]);
    expect(drafts[0]?.why.startsWith(`"${RHDS_SOURCES[RULE][0].quote}"`)).toBe(true);
    expect(drafts[0]?.fix).toContain('accessible-label');
    expect(drafts[0]?.why).toContain('no h1 to h6 heading');
    expect(drafts[0]?.fix).toContain('h1 to h6');
  });

  it('reports a closed dialog with no name source as unverified, because it is not in the tree', async () => {
    const { drafts } = await run({ query: { [DIALOG_SEL.host]: [host] } });

    expect(byRule(drafts, RULE)).toEqual([expect.objectContaining({ rule: RULE, confidence: 'unverified', elementPath: host })]);
  });

  it('reports unverified for a dialog with no name source that never upgraded', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host] },
      markup: { [host]: { defined: false } },
      shadow: { [host]: { [DIALOG_SEL.inner]: ax('', 'dialog') } },
    });

    expect(byRule(drafts, RULE)).toEqual([expect.objectContaining({ rule: RULE, confidence: 'unverified' })]);
    expect(drafts[0]?.why).toContain('not upgraded');
  });

  it('passes a dialog with an accessible-label, even closed', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host] },
      markup: { [host]: { attributes: { 'accessible-label': 'Settings' } } },
    });
    expect(drafts).toEqual([]);
  });

  it('passes a dialog with a heading in its header or default slot, even closed', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host], [headingsIn(host)]: [`${host} > h2`] },
    });
    expect(drafts).toEqual([]);
  });

  it('passes a dialog whose trigger element has text, the fallback name', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host] },
      markup: {
        [host]: { attributes: { trigger: 'open-settings' } },
        [triggerOf('open-settings')]: { defaultSlotText: 'Open settings' },
      },
    });
    expect(drafts).toEqual([]);
  });

  it('does not count a trigger that names no element, or one with no text', async () => {
    const missing = await run({
      query: { [DIALOG_SEL.host]: [host] },
      markup: { [host]: { attributes: { trigger: 'nowhere' } } },
      shadow: { [host]: { [DIALOG_SEL.inner]: ax(null, 'dialog') } },
    });
    expect(byRule(missing.drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'fail' })]);

    const blank = await run({
      query: { [DIALOG_SEL.host]: [host] },
      markup: { [host]: { attributes: { trigger: 'icon-trigger' } }, [triggerOf('icon-trigger')]: { defaultSlotText: '' } },
      shadow: { [host]: { [DIALOG_SEL.inner]: ax('', 'dialog') } },
    });
    expect(byRule(blank.drafts, RULE)).toEqual([expect.objectContaining({ confidence: 'fail' })]);
  });

  it('passes an open dialog with no markup name source when the tree names it', async () => {
    const { drafts } = await run({
      query: { [DIALOG_SEL.host]: [host] },
      shadow: { [host]: { [DIALOG_SEL.inner]: ax('Settings', 'dialog') } },
    });
    expect(drafts).toEqual([]);
  });

  it('looks for h1 to h6 headings in the header slot or the default slot, and escapes trigger ids', () => {
    // The component takes any unslotted heading as its name, h1 included, and slot="" is the
    // default slot.
    expect(headingsIn('#d')).toBe(
      [
        '#d > :is(h1, h2, h3, h4, h5, h6)[slot="header"]',
        '#d > [slot="header"] :is(h1, h2, h3, h4, h5, h6)',
        '#d > :is(h1, h2, h3, h4, h5, h6):is(:not([slot]), [slot=""])',
        '#d > :is(:not([slot]), [slot=""]) :is(h1, h2, h3, h4, h5, h6)',
      ].join(', '),
    );
    expect(triggerOf('a"b\\c')).toBe('[id="a\\"b\\\\c"]');
  });
});
