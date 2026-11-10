/**
 * Builds small Figma files for importer tests. Each test places a few design elements and kit
 * stamps in one frame named "Screen". Component names follow the GitHub Annotation Toolkit.
 */
import type { FigmaFile, FigmaNode, FigmaRect } from '../../../src/import/figma/types.js';

export const KIT_SETS: Record<string, string> = {
  heading: '❖ Heading Stamp',
  landmark: 'Landmark Stamp',
  ordering: 'Ordering Stamp',
  button: 'Button Stamp',
  buttonDetails: 'Button Details',
  image: 'Image Stamp',
  media: 'Media Stamp',
  link: 'Link Stamp',
  list: 'List Stamp',
  table: 'Table Stamp',
  note: 'Note Stamp',
  headingDetails: '❖ Heading Details',
  landmarkDetails: 'Landmark Details',
  linkDetails: 'Link Details',
  imageDetails: 'Image Details',
  card: 'User card',
};

export function rect(x: number, y: number, width: number, height: number): FigmaRect {
  return { x, y, width, height };
}

export function text(id: string, characters: string, box: FigmaRect): FigmaNode {
  return { id, name: characters, type: 'TEXT', characters, absoluteBoundingBox: box };
}

export function kit(
  id: string,
  set: keyof typeof KIT_SETS,
  box: FigmaRect,
  props: Record<string, string> = {},
  name = (KIT_SETS[set] ?? set).replace(/^❖ /u, ''),
): FigmaNode {
  return {
    id,
    name,
    type: 'INSTANCE',
    componentId: `c-${set}`,
    absoluteBoundingBox: box,
    componentProperties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: 'TEXT', value: v }])),
    children: [],
  };
}

export function screen(children: FigmaNode[]): FigmaFile {
  const components: FigmaFile['components'] = {};
  const componentSets: NonNullable<FigmaFile['componentSets']> = {};
  for (const [key, name] of Object.entries(KIT_SETS)) {
    components[`c-${key}`] = { name: 'Variant=default', componentSetId: `s-${key}` };
    componentSets[`s-${key}`] = { name };
  }
  return {
    name: 'Test file',
    version: '7',
    lastModified: '2026-10-09T00:00:00Z',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'Page 1',
          type: 'CANVAS',
          children: [{ id: '1:0', name: 'Screen', type: 'FRAME', absoluteBoundingBox: rect(0, 0, 1000, 800), children }],
        },
      ],
    },
    components,
    componentSets,
  };
}

export const screenOptions = { fileKey: 'K', frames: { Screen: 'screen' }, owner: 'design' };
