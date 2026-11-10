/**
 * The target finder and the fake editor, on fake pages. The finder reads only what the engine
 * trusts, keeps or drops each match by its tree and text facts, and says why when nothing on the
 * page can carry the defect. The fake editor applies each edit kind and locates reported elements
 * the way the page function does. The real editor refuses a page the scan browser did not open.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePage } from '../../../src/deps/fakes.js';
import type { Edit } from '../../../src/measure/sensitivity/catalog.js';
import { EDIT_KINDS } from '../../../src/measure/sensitivity/catalog.js';
import {
  makeFakeDom,
  makeFakeDomPage,
  makeFakeMutationEditor,
  type FakeDom,
} from '../../../src/measure/sensitivity/fakes.js';
import { makeRealMutationEditor } from '../../../src/measure/sensitivity/real-editor.js';
import { findTargets } from '../../../src/measure/sensitivity/targets.js';

function dom(): FakeDom {
  return makeFakeDom({
    elements: [
      { path: 'main', role: 'main', name: null },
      { path: '#save', parent: 'main', role: 'button', name: 'Save', text: 'Save' },
      { path: '#close', parent: 'main', role: 'button', name: 'Close', attributes: { 'aria-label': 'Close' } },
      { path: '#blank', parent: 'main', role: 'button', name: '' },
      { path: '#hidden-dialog', parent: 'main' },
      { path: '#intro', parent: 'main', role: 'paragraph', name: null, text: 'Welcome' },
      { path: 'x-card', parent: 'main' },
      { path: 'x-card >> button', parent: 'x-card', host: 'x-card', role: 'button', name: 'Open', text: 'Open' },
    ],
    selectors: {
      button: ['#save', '#close', '#blank'],
      'button[aria-label]': ['#close'],
      '[role="dialog"]': ['#hidden-dialog'],
      'main p': ['#intro'],
    },
  });
}

describe('findTargets', () => {
  it('takes the first match the tree agrees with', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'button', tree: { roles: ['button'], named: true } })).toEqual({
      kind: 'found',
      paths: ['#save'],
    });
  });

  it('takes every match when asked, and drops one the tree gives no name', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'button', tree: { named: true }, every: true })).toEqual({
      kind: 'found',
      paths: ['#save', '#close'],
    });
  });

  it('keeps or drops a match by whether it holds text of its own', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'button', text: 'none', tree: { named: true } })).toEqual({
      kind: 'found',
      paths: ['#close'],
    });
    expect(await findTargets(page, { selector: 'main p', text: 'some' })).toEqual({ kind: 'found', paths: ['#intro'] });
  });

  it('finds an element the tree does not show when the finder reads no tree', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: '[role="dialog"]' })).toEqual({ kind: 'found', paths: ['#hidden-dialog'] });
    expect((await findTargets(page, { selector: '[role="dialog"]', tree: {} })).kind).toBe('none');
  });

  it('says why when nothing matches', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'img[alt]' })).toEqual({
      kind: 'none',
      reason: 'no element on the page matches the target selector',
    });
    expect(await findTargets(page, { selector: 'button', tree: { roles: ['link'] } })).toEqual({
      kind: 'none',
      reason: 'no element the target selector matches has the tree and text facts the defect needs',
    });
  });

  it('refuses a page with fewer matches than the defect needs', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'button[aria-label]', atLeast: 2 })).toEqual({
      kind: 'none',
      reason: 'the target selector matches 1 element, and the defect needs at least 2',
    });
    expect(await findTargets(page, { selector: 'button', tree: { named: true }, every: true, atLeast: 3 })).toEqual({
      kind: 'none',
      reason: '2 elements on the page can carry the defect, and it needs at least 3',
    });
  });

  it('counts every qualifying element against atLeast, and still takes only the first', async () => {
    const page = makeFakeDomPage(dom());
    expect(await findTargets(page, { selector: 'button', tree: { named: true }, atLeast: 2 })).toEqual({
      kind: 'found',
      paths: ['#save'],
    });
  });

  it('only reads the page', async () => {
    const writes: string[] = [];
    const page = makeFakeDomPage(dom(), {
      click: async () => void writes.push('click'),
      press: async () => void writes.push('press'),
      tab: async () => void writes.push('tab'),
    });
    await findTargets(page, { selector: 'button', tree: { named: true }, text: 'some', every: true });
    expect(writes).toEqual([]);
  });
});

describe('the fake mutation editor', () => {
  const kinds: Record<(typeof EDIT_KINDS)[number], Edit> = {
    'remove-attribute': { kind: 'remove-attribute', names: ['aria-label'] },
    'set-attribute': { kind: 'set-attribute', name: 'tabindex', value: '-1' },
    'remove-text-name': { kind: 'remove-text-name' },
    'set-style': { kind: 'set-style', styles: { color: '#999999' } },
    'remove-element': { kind: 'remove-element' },
    'replace-role': { kind: 'replace-role', role: 'buton' },
    'swallow-key': { kind: 'swallow-key', key: 'Tab' },
    'ignore-focus-calls': { kind: 'ignore-focus-calls' },
  };

  it('applies every edit kind and records it', async () => {
    for (const kind of EDIT_KINDS) {
      const fake = dom();
      const page = makeFakeDomPage(fake);
      const outcome = await makeFakeMutationEditor().apply(page, ['#close'], kinds[kind]);
      expect(outcome.kind, kind).toBe('applied');
      expect(fake.edits, kind).toEqual([{ targets: ['#close'], edit: kinds[kind] }]);
    }
  });

  it('changes what the tree and the markup report', async () => {
    const fake = dom();
    const page = makeFakeDomPage(fake);
    await makeFakeMutationEditor().apply(page, ['#save'], { kind: 'remove-text-name' });
    expect((await page.axAt('#save'))?.name).toBe('');
    expect((await page.hostMarkup('#save'))?.defaultSlotText).toBe('');
    await makeFakeMutationEditor().apply(page, ['#close'], { kind: 'remove-element' });
    expect(await page.queryAll('button')).toEqual([{ selector: '#save' }, { selector: '#blank' }]);
  });

  it('locates reported elements against the changed ones', async () => {
    const page = makeFakeDomPage(dom());
    const outcome = await makeFakeMutationEditor().apply(page, ['main'], { kind: 'remove-attribute', names: ['role'] });
    if (outcome.kind !== 'applied') throw new Error('edit not applied');
    expect(await outcome.edit.locate(['main', '#save', '#nowhere'])).toEqual(['target', 'inside', 'unresolved']);

    // Around is only the shadow host of a changed element, never every ancestor.
    const second = await makeFakeMutationEditor().apply(makeFakeDomPage(dom()), ['#save'], { kind: 'remove-text-name' });
    if (second.kind !== 'applied') throw new Error('edit not applied');
    expect(await second.edit.locate(['main', '#close'])).toEqual(['elsewhere', 'elsewhere']);
    const shadowed = await makeFakeMutationEditor().apply(makeFakeDomPage(dom()), ['x-card >> button'], { kind: 'remove-text-name' });
    if (shadowed.kind !== 'applied') throw new Error('edit not applied');
    expect(await shadowed.edit.locate(['x-card', 'main'])).toEqual(['around', 'elsewhere']);
  });

  it('stands a removed element\'s parent in for it', async () => {
    const page = makeFakeDomPage(dom());
    const outcome = await makeFakeMutationEditor().apply(page, ['#save'], { kind: 'remove-element' });
    if (outcome.kind !== 'applied') throw new Error('edit not applied');
    expect(await outcome.edit.locate(['main', '#save'])).toEqual(['target', 'unresolved']);
  });

  it('fails an edit whose target is gone, and one the page refuses', async () => {
    const fake = dom();
    const page = makeFakeDomPage(fake);
    expect(await makeFakeMutationEditor().apply(page, ['#missing'], { kind: 'remove-text-name' })).toEqual({
      kind: 'failed',
      reason: 'a target element could not be found again as one element',
    });
    expect(await makeFakeMutationEditor({ refuse: 'the page kept an attribute the edit removed' }).apply(page, ['#save'], kinds['remove-attribute'])).toEqual({
      kind: 'failed',
      reason: 'the page kept an attribute the edit removed',
    });
    expect(fake.edits).toEqual([]);
  });
});

describe('the real mutation editor', () => {
  it('refuses a page the scan browser did not open', async () => {
    expect(await makeRealMutationEditor().apply(makeFakePage(), ['#save'], { kind: 'remove-text-name' })).toEqual({
      kind: 'failed',
      reason: 'the page was not opened by the scan browser, so no edit can reach it',
    });
  });
});
