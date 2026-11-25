import { describe, expect, it } from 'vitest';
import { propertyValue } from '../../../src/import/figma/kit.js';
import { readFigmaFile } from '../../../src/import/figma/types.js';
import { slotInstance, usersScreen } from './users-screen.fixture.js';

describe('readFigmaFile', () => {
  it('reads the mock file after a JSON round trip, as it arrives from the network', () => {
    const read = readFigmaFile(JSON.parse(JSON.stringify(usersScreen)));
    expect(read?.version).toBe('4242');
    expect(read?.document.children?.[0]?.children?.[0]?.name).toBe('Users');
  });

  it('keeps only the fields usabl reads', () => {
    const read = readFigmaFile(JSON.parse(JSON.stringify(usersScreen)));
    const users = read?.document.children?.[0]?.children?.[0];
    expect(users).not.toHaveProperty('blendMode');
    expect(read).not.toHaveProperty('role');
    expect(read?.components['10:1']).toEqual({ key: 'k-heading-h1', name: 'Level=h1', componentSetId: '10:0' });
  });

  it('reads a file whose instance has a slot property, and never reads the slot as text', () => {
    // Figma's file format allows a slot property, whose value is an id object, not text.
    const slotted = structuredClone(usersScreen);
    const users = slotted.document.children?.[0]?.children?.[0];
    if (users?.children === undefined) throw new Error('fixture has no Users frame');
    users.children.push(slotInstance('6:1'));
    const read = readFigmaFile(JSON.parse(JSON.stringify(slotted)));
    expect(read).not.toBeNull();
    const card = read?.document.children?.[0]?.children?.[0]?.children?.find((node) => node.id === '6:1');
    expect(card === undefined ? 'missing' : propertyValue(card, 'Content')).toBeNull();
  });

  it.each([
    ['an empty object', {}],
    ['a string', 'not a file'],
    ['a node with no id', { ...usersScreen, document: { name: 'Document', type: 'DOCUMENT' } }],
    ['a version that is a number', { ...usersScreen, version: 4242 }],
    ['children that are not a list', { ...usersScreen, document: { ...usersScreen.document, children: 'x' } }],
    ['a box with a value that is not a number', { ...usersScreen, document: { ...usersScreen.document, absoluteBoundingBox: { x: 'a', y: 0, width: 1, height: 1 } } }],
  ])('refuses %s', (_, value) => {
    expect(readFigmaFile(value)).toBeNull();
  });

  it('refuses a file nested too deeply to check, without throwing', () => {
    let node: Record<string, unknown> = { id: 'leaf', name: 'leaf', type: 'FRAME' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      node = { id: `n${depth}`, name: 'n', type: 'FRAME', children: [node] };
    }
    expect(readFigmaFile({ ...usersScreen, document: node })).toBeNull();
  });
});

// These pin what a read keeps and what it refuses, so a change of schema library version cannot
// change either without a test failing.
describe('readFigmaFile shape', () => {
  const leaf = { id: '1:1', name: 'Leaf', type: 'FRAME' };
  const file = (document: unknown, extra: Record<string, unknown> = {}) => ({
    name: 'File',
    version: '1',
    lastModified: '2026-01-01T00:00:00Z',
    document,
    components: {},
    ...extra,
  });

  it('keeps exactly the fields it reads, and adds none the file did not write', () => {
    const node = {
      ...leaf,
      blendMode: 'NORMAL',
      absoluteBoundingBox: null,
      componentProperties: {
        Label: { type: 'TEXT', value: 'Save', boundVariables: {} },
        Content: { type: 'SLOT', value: { guid: { sessionID: 1, localID: 2, extra: 3 }, other: 'x' } },
      },
      annotations: [{ label: 'note', measurements: [], extra: 1 }, {}],
    };
    const read = readFigmaFile(
      file(node, {
        role: 'owner',
        components: { '10:1': { key: 'k', name: 'Button', description: 'not read' } },
        componentSets: { '10:0': { name: 'Buttons', description: 'not read' } },
      }),
    );
    expect(read).toEqual({
      name: 'File',
      version: '1',
      lastModified: '2026-01-01T00:00:00Z',
      document: {
        ...leaf,
        absoluteBoundingBox: null,
        componentProperties: {
          Label: { type: 'TEXT', value: 'Save' },
          Content: { type: 'SLOT', value: { guid: { sessionID: 1, localID: 2 } } },
        },
        annotations: [{ label: 'note' }, {}],
      },
      components: { '10:1': { key: 'k', name: 'Button' } },
      componentSets: { '10:0': { name: 'Buttons' } },
    });
    expect(read).not.toHaveProperty('document.children');
  });

  it('reads a slot id too large for a number, which JSON reads as Infinity', () => {
    const json = JSON.stringify(
      file({ ...leaf, componentProperties: { Content: { type: 'SLOT', value: { guid: { sessionID: 7, localID: 8 } } } } }),
    ).replace('"localID":8', '"localID":1e999');
    const read = readFigmaFile(JSON.parse(json));
    expect(read?.document.componentProperties?.Content?.value).toEqual({ guid: { sessionID: 7, localID: Infinity } });
  });

  // JSON.parse makes "__proto__" an own key, the way a file from the network holds it. Its value is
  // checked like any other entry, and the entry is never kept, so it cannot reach an object's
  // prototype.
  const withProtoEntry = (json: string) => JSON.parse(json) as unknown;
  const node = (properties: string) => `{"id":"1:1","name":"Leaf","type":"FRAME"${properties}}`;
  const fileJson = (fields: string, document = node('')) =>
    `{"name":"File","version":"1","lastModified":"2026-01-01T00:00:00Z","document":${document},"components":{}${fields}}`;

  it.each([
    ['components', fileJson(',"components":{"__proto__":5,"10:1":{"name":"Button"}}').replace('"components":{},', '')],
    ['componentSets', fileJson(',"componentSets":{"__proto__":5,"10:0":{"name":"Buttons"}}')],
    ['componentProperties', fileJson('', node(',"componentProperties":{"__proto__":5,"Label":{"type":"TEXT","value":"Save"}}'))],
  ])('refuses a file whose %s entry named __proto__ does not match', (_, json) => {
    expect(readFigmaFile(withProtoEntry(json))).toBeNull();
  });

  it('reads a file whose map entries named __proto__ match, and keeps none of them', () => {
    const json = fileJson(
      ',"componentSets":{"__proto__":{"name":"Hidden"},"10:0":{"name":"Buttons"}}',
      node(',"componentProperties":{"__proto__":{"type":"TEXT","value":"x"},"Label":{"type":"TEXT","value":"Save"}}'),
    ).replace('"components":{}', '"components":{"__proto__":{"name":"Hidden"},"10:1":{"name":"Button"}}');
    const read = readFigmaFile(withProtoEntry(json));
    expect(read?.components).toEqual({ '10:1': { name: 'Button' } });
    expect(read?.componentSets).toEqual({ '10:0': { name: 'Buttons' } });
    expect(read?.document.componentProperties).toEqual({ Label: { type: 'TEXT', value: 'Save' } });
    for (const map of [read?.components, read?.componentSets, read?.document.componentProperties]) {
      expect(map === undefined ? 'missing' : Object.hasOwn(map, '__proto__')).toBe(false);
      expect(map === undefined ? 'missing' : Object.getPrototypeOf(map)).toBe(Object.prototype);
    }
  });

  it.each([
    ['a box with an infinite size', file({ ...leaf, absoluteBoundingBox: { x: 0, y: 0, width: Infinity, height: 1 } })],
    ['a box that is not a number', file({ ...leaf, absoluteBoundingBox: { x: 0, y: 0, width: Number.NaN, height: 1 } })],
    ['a property value that is a number', file({ ...leaf, componentProperties: { Size: { type: 'NUMBER', value: 3 } } })],
    ['components that are a list', file(leaf, { components: [] })],
    ['a component with no name', file(leaf, { components: { '10:1': { key: 'k' } } })],
    ['a document that is null', file(null)],
  ])('refuses %s', (_, value) => {
    expect(readFigmaFile(value)).toBeNull();
  });
});
