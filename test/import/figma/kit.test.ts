import { describe, expect, it } from 'vitest';
import { kitNote, propertyValue, stampKind } from '../../../src/import/figma/kit.js';
import type { FigmaFile, FigmaNode } from '../../../src/import/figma/types.js';

const file: Pick<FigmaFile, 'components' | 'componentSets'> = {
  components: { 'c:1': { name: 'Level=h1', componentSetId: 's:1' } },
  componentSets: { 's:1': { name: '❖ Heading Stamp' } },
};

describe('stampKind', () => {
  it('recognizes a stamp by its component set name, ignoring the kit marker', () => {
    const node: FigmaNode = { id: '1', name: 'x', type: 'INSTANCE', componentId: 'c:1' };
    expect(stampKind(node, file)).toBe('heading-stamp');
  });

  it('returns null for anything else', () => {
    expect(stampKind({ id: '2', name: 'Rect', type: 'RECTANGLE' }, file)).toBeNull();
  });

  it('never reads an inherited property for a component id', () => {
    const node: FigmaNode = { id: '3', name: 'Heading Stamp', type: 'INSTANCE', componentId: 'constructor' };
    // No component is listed under that id, so the layer name decides.
    expect(stampKind(node, file)).toBe('heading-stamp');
    const plain: FigmaNode = { id: '4', name: 'Card', type: 'INSTANCE', componentId: 'toString' };
    expect(stampKind(plain, file)).toBeNull();
  });
});

describe('kitNote', () => {
  const kitFile: Pick<FigmaFile, 'components' | 'componentSets'> = {
    components: {
      'c:1': { name: 'Level=h1', componentSetId: 's:1' },
      'c:2': { name: 'Type=Decorative', componentSetId: 's:2' },
      'c:3': { name: '❖ Heading Details' },
      'c:4': { name: 'User card' },
    },
    componentSets: { 's:1': { name: '❖ Heading Stamp' }, 's:2': { name: 'Image Stamp' } },
  };
  const instance = (componentId: string | undefined, name = 'layer'): FigmaNode => ({
    id: 'n',
    name,
    type: 'INSTANCE',
    ...(componentId === undefined ? {} : { componentId }),
  });

  it('names a stamp it maps with its kind', () => {
    expect(kitNote(instance('c:1'), kitFile)).toEqual({ kind: 'heading-stamp', label: 'Heading Stamp' });
  });

  it('recognizes a kit stamp or details card it does not map, by the name ending', () => {
    expect(kitNote(instance('c:2'), kitFile)).toEqual({ kind: null, label: 'Image Stamp' });
    expect(kitNote(instance('c:3'), kitFile)).toEqual({ kind: null, label: 'Heading Details' });
  });

  it('falls back to the instance name when the file lists no component for it', () => {
    expect(kitNote(instance('c:missing', 'Link Stamp'), kitFile)).toEqual({ kind: null, label: 'Link Stamp' });
    expect(kitNote(instance(undefined, 'Table Stamp'), kitFile)).toEqual({ kind: null, label: 'Table Stamp' });
  });

  it('returns null for a design component or a node that is not an instance', () => {
    expect(kitNote(instance('c:4'), kitFile)).toBeNull();
    expect(kitNote({ id: 'f', name: 'Image Stamp', type: 'FRAME' }, kitFile)).toBeNull();
  });
});

describe('propertyValue', () => {
  it('reads a property with or without the Figma id suffix', () => {
    const node: FigmaNode = {
      id: '3',
      name: 's',
      type: 'INSTANCE',
      componentProperties: { 'Order ##7:3': { type: 'TEXT', value: '2' }, Level: { type: 'VARIANT', value: 'h2' } },
    };
    expect(propertyValue(node, 'Order #')).toBe('2');
    expect(propertyValue(node, 'level')).toBe('h2');
    expect(propertyValue(node, 'Missing')).toBeNull();
  });
});
