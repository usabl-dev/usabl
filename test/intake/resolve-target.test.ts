import { describe, expect, it, vi } from 'vitest';
import type { AxNode, ElementRef, Page } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { findByRole, resolveTarget } from '../../src/intake/resolve-target.js';

function pageWith(nodes: Record<string, AxNode | null>, everywhere?: number): Page {
  const refs: ElementRef[] = Object.keys(nodes).map((selector) => ({ selector }));
  return makeFakePage({
    queryAll: async () => refs,
    axAt: async (selector: string) => nodes[selector] ?? null,
    countEverywhere: async () => everywhere ?? refs.length,
  });
}

const button = (name: string | null): AxNode => ({ name, role: 'button', states: {} });

describe('resolveTarget', () => {
  it('finds the one element whose role and accessible name match', async () => {
    const page = pageWith({ '#a': button('Refresh'), '#b': button('Delete') });
    const found = await resolveTarget(page, { role: 'button', name: 'Refresh' });
    expect(found).toEqual({ kind: 'one', match: { selector: '#a', node: button('Refresh') } });
  });

  it('ignores surrounding spaces and keeps case', async () => {
    const page = pageWith({ '#a': button(' Refresh ') });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
    expect((await resolveTarget(page, { role: 'button', name: 'refresh' })).kind).toBe('none');
  });

  it('uses the accessibility tree role, not the tag', async () => {
    const page = pageWith({ '#a': { name: 'Refresh', role: 'generic', states: {} } });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('none');
  });

  it('accepts both role names Chromium uses for images and search fields', async () => {
    const image = pageWith({ '#a': { name: 'Team photo', role: 'image', states: {} } });
    expect((await resolveTarget(image, { role: 'img', name: 'Team photo' })).kind).toBe('one');
    const search = pageWith({ '#s': { name: 'Filter users', role: 'searchbox', states: {} } });
    expect((await resolveTarget(search, { role: 'textbox', name: 'Filter users' })).kind).toBe('one');
  });

  it('skips an element the accessibility tree ignores', async () => {
    const page = pageWith({ '#hidden': null, '#a': button('Refresh') });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
  });

  it('refuses to pick when more than one element matches, because which one is meant would be a guess', async () => {
    const page = pageWith({ '#a': button('Delete'), '#b': button('Delete') });
    expect(await resolveTarget(page, { role: 'button', name: 'Delete' })).toEqual({ kind: 'many', count: 2 });
  });

  it('reports no match as none', async () => {
    const page = pageWith({ '#a': button('Delete') });
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({ kind: 'none' });
  });

  it('refuses when candidates sit where it cannot read them, such as a shadow root or a frame', async () => {
    // Two buttons in the page, one more the document query cannot see.
    const one = pageWith({ '#a': button('Refresh'), '#b': button('Delete') }, 3);
    expect(await resolveTarget(one, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'out-of-reach',
      found: 1,
      outOfReach: 1,
    });
    const none = pageWith({ '#b': button('Delete') }, 2);
    expect(await resolveTarget(none, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'out-of-reach',
      found: 0,
      outOfReach: 1,
    });
  });

  it('still refuses as many when two readable elements match, whatever else is out of reach', async () => {
    const page = pageWith({ '#a': button('Delete'), '#b': button('Delete') }, 5);
    expect(await resolveTarget(page, { role: 'button', name: 'Delete' })).toEqual({ kind: 'many', count: 2 });
  });

  it('asks the page with one fixed selector per role, never with design text', async () => {
    const queryAll = vi.fn(async () => [] as ElementRef[]);
    const countEverywhere = vi.fn(async () => 0);
    const page = makeFakePage({ queryAll, countEverywhere });
    await resolveTarget(page, { role: 'button', name: '"], script, [x="' });
    expect(queryAll).toHaveBeenCalledTimes(1);
    const [selector] = queryAll.mock.calls[0] as unknown as [string];
    expect(selector).not.toContain('script');
    expect(countEverywhere).toHaveBeenCalledWith(selector);
  });
});

describe('findByRole', () => {
  it('lists every readable element with a role, for landmark checks', async () => {
    const page = pageWith({ '#m': { name: null, role: 'main', states: {} }, '#x': { name: null, role: 'generic', states: {} } });
    const found = await findByRole(page, 'main');
    expect(found.matches.map((m) => m.selector)).toEqual(['#m']);
    expect(found.outOfReach).toBe(0);
  });
});
