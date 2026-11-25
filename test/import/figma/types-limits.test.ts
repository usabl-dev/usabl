import { describe, expect, it } from 'vitest';
import { figmaApiBase, FigmaFetchError, fetchFigmaFile } from '../../../src/import/figma/fetch.js';
import { checkFigmaFile, readFigmaFile } from '../../../src/import/figma/types.js';
import { MOCK_TOKEN } from './mock-server.js';

// Every list and map in a Figma file has a size limit far above what a real design file holds. A
// list or map past its limit is refused on its size alone, before any entry is read, and the
// fetch failure names the limit. A file exactly at each limit is still read.

const leaf = (index: number) => ({ id: `1:${index}`, name: 'Leaf', type: 'FRAME' });

function file(document: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'File', version: '1', lastModified: '2026-01-01T00:00:00Z', document, components: {}, ...extra };
}

function entries<T>(count: number, make: (index: number) => T): Record<string, T> {
  const map: Record<string, T> = {};
  for (let index = 0; index < count; index += 1) {
    map[`${index}:1`] = make(index);
  }
  return map;
}

function list<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

const component = () => ({ name: 'Button' });
const property = () => ({ type: 'TEXT', value: 'Save' });
const note = () => ({ label: 'note' });

// Each case: a file at the limit, the same file one entry past it, and the words the refusal uses.
const cases: [string, unknown, unknown, string][] = [
  [
    'components',
    file(leaf(0), { components: entries(100_000, component) }),
    file(leaf(0), { components: entries(100_001, component) }),
    'components can list at most 100,000 entries',
  ],
  [
    'componentSets',
    file(leaf(0), { componentSets: entries(100_000, component) }),
    file(leaf(0), { componentSets: entries(100_001, component) }),
    'componentSets can list at most 100,000 entries',
  ],
  [
    'componentProperties',
    file({ ...leaf(0), componentProperties: entries(100_000, property) }),
    file({ ...leaf(0), componentProperties: entries(100_001, property) }),
    'componentProperties can list at most 100,000 entries',
  ],
  [
    'children',
    file({ ...leaf(0), children: list(100_000, leaf) }),
    file({ ...leaf(0), children: list(100_001, leaf) }),
    'children can list at most 100,000 nodes',
  ],
  [
    'annotations',
    file({ ...leaf(0), annotations: list(1000, note) }),
    file({ ...leaf(0), annotations: list(1001, note) }),
    'annotations can list at most 1,000 notes',
  ],
];

describe('the size limits of a Figma file', () => {
  // A read at the limit checks every entry, which takes a few seconds for the largest maps.
  it.each(cases)('reads %s at the limit and refuses one entry more', (_, atLimit, overLimit) => {
    expect(readFigmaFile(atLimit)).not.toBeNull();
    expect(readFigmaFile(overLimit)).toBeNull();
  }, 60_000);

  // Entries that would each fail on their own still give the limit as the reason, because the size
  // is checked first.
  it.each([
    ['components', file(leaf(0), { components: entries(100_001, () => 5) }), 'components can list at most 100,000 entries'],
    ['children', file({ ...leaf(0), children: list(100_001, () => ({})) }), 'children can list at most 100,000 nodes'],
  ])('refuses %s past the limit before it reads an entry', (_, overLimit, words) => {
    expect(checkFigmaFile(overLimit)).toEqual({ ok: false, limit: words });
  });
});

describe('a Figma answer past a size limit', () => {
  const base = (() => {
    const read = figmaApiBase({ FIGMA_API_BASE: 'http://127.0.0.1:9/' });
    if (!read.ok) throw new Error(read.message);
    return read.base;
  })();

  async function failure(body: unknown): Promise<string> {
    const answer = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    try {
      await fetchFigmaFile(base, 'MOCKKEY', MOCK_TOKEN, answer);
    } catch (error) {
      expect(error).toBeInstanceOf(FigmaFetchError);
      return (error as Error).message;
    }
    throw new Error('expected the fetch to fail');
  }

  it.each(cases)('names the %s limit in the failure, and no file text', async (_, __, overLimit, words) => {
    expect(await failure(overLimit)).toBe(`Figma returned a file usabl cannot read: ${words}.`);
  });

  it('still gives the plain failure for a file that is not readable for another reason', async () => {
    expect(await failure({ name: 'File' })).toBe('Figma returned a file usabl cannot read.');
  });
});
