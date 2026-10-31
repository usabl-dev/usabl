import { describe, expect, it } from 'vitest';
import type { AxNode } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { IMAGE_SELECTOR, MAX_PAGE_IMAGES, readPageImages } from '../../src/providers/page-images.js';

function pageWith(
  nodes: Record<string, AxNode | null>,
  order: string[] = Object.keys(nodes),
  attributes: Record<string, Record<string, string | null>> = {},
) {
  const asked: string[] = [];
  const page = makeFakePage({
    queryAll: async (selector) => {
      asked.push(selector);
      return order.map((path) => ({ selector: path }));
    },
    axAt: async (selector) => nodes[selector] ?? null,
    ancestorAttributes: async (selector) => {
      const own = attributes[selector];
      // The parent carries an empty alt, which must not count for the image under it.
      return own === undefined ? { kind: 'not-found' } : { kind: 'chain', chain: [own, { alt: '', role: null }] };
    },
  });
  return { page, asked };
}

describe('readPageImages', () => {
  it('reads every image the page shows, in document order, with its accessible name and role', async () => {
    const { page, asked } = pageWith(
      {
        '#logo': { name: 'Company logo', role: 'img', states: {} },
        '#divider': { name: '', role: 'none', states: {} },
        '#spacer': null,
        '#icon': null,
        '#chart': null,
      },
      undefined,
      {
        '#logo': { alt: 'Company logo', role: null },
        '#spacer': { alt: '', role: null },
        '#icon': { alt: null, role: 'Presentation img' },
        '#chart': { alt: null, role: 'img none' },
      },
    );

    const read = await readPageImages(page);

    expect(asked).toEqual([IMAGE_SELECTOR]);
    expect(read.images).toEqual([
      { elementPath: '#logo', name: 'Company logo', role: 'img', decorative: false },
      { elementPath: '#divider', name: '', role: 'none', decorative: true },
      { elementPath: '#spacer', name: null, role: null, decorative: true },
      { elementPath: '#icon', name: null, role: null, decorative: true },
      { elementPath: '#chart', name: null, role: null, decorative: false },
    ]);
    expect(read.notListed).toBe(0);
  });

  it('lists at most the cap and counts the rest instead of dropping them in silence', async () => {
    const order = Array.from({ length: MAX_PAGE_IMAGES + 3 }, (_, index) => `#img-${String(index)}`);
    const { page } = pageWith(
      Object.fromEntries(order.map((path) => [path, { name: path, role: 'img', states: {} }])),
      order,
    );

    const read = await readPageImages(page);

    expect(read.images).toHaveLength(MAX_PAGE_IMAGES);
    expect(read.images[0]?.elementPath).toBe('#img-0');
    expect(read.notListed).toBe(3);
  });

  it('reads the same page the same way twice', async () => {
    const { page } = pageWith({
      '#b': { name: 'B', role: 'img', states: {} },
      '#a': { name: 'A', role: 'img', states: {} },
    });

    expect(await readPageImages(page)).toEqual(await readPageImages(page));
  });
});
