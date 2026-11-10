/**
 * A mock Figma design file for a Users screen, as GET /v1/files/:key returns it. The accessibility
 * notes follow the kit in src/import/figma/kit.ts: stamps are component instances placed over the design
 * element they annotate, and coordinates are absolute, as in the API.
 *
 * Every node and the file itself are typed with Figma's published types from @figma/rest-api-spec,
 * so this file does not compile unless it carries every field those types require, filled with
 * plain defaults. It is a file Figma could send, not only the subset usabl reads. The package holds
 * types only, and only tests import it.
 */
import type {
  CanvasNode,
  Component,
  ComponentProperty,
  ComponentSet,
  DocumentNode,
  FrameNode,
  GetFileResponse,
  InstanceNode,
  Rectangle,
  SubcanvasNode,
  TextNode,
} from '@figma/rest-api-spec';
import type { FigmaAnnotation } from '../../../src/import/figma/types.js';

function box(x: number, y: number, width: number, height: number): Rectangle {
  return { x, y, width, height };
}

// The fields every layer here shares, with plain defaults.
function layer(id: string, name: string, rect: Rectangle) {
  return {
    id,
    name,
    visible: true,
    scrollBehavior: 'SCROLLS' as const,
    blendMode: 'PASS_THROUGH' as const,
    absoluteBoundingBox: rect,
    absoluteRenderBounds: rect,
    fills: [],
    strokes: [],
    effects: [],
  };
}

function text(id: string, characters: string, rect: Rectangle): TextNode {
  return {
    ...layer(id, characters, rect),
    type: 'TEXT',
    characters,
    style: {},
    characterStyleOverrides: [],
    styleOverrideTable: {},
    lineTypes: ['NONE'],
    lineIndentations: [0],
  };
}

function frame(id: string, name: string, rect: Rectangle, children: SubcanvasNode[]): FrameNode {
  return { ...layer(id, name, rect), type: 'FRAME', children, clipsContent: false };
}

function stamp(
  id: string,
  name: string,
  componentId: string,
  rect: Rectangle,
  componentProperties: Record<string, ComponentProperty>,
): InstanceNode {
  return {
    ...layer(id, name, rect),
    type: 'INSTANCE',
    children: [],
    clipsContent: false,
    componentId,
    componentProperties,
    overrides: [],
  };
}

function component(key: string, name: string, componentSetId: string): Component {
  return { key, name, description: '', componentSetId, documentationLinks: [], remote: true };
}

function componentSet(key: string, name: string): ComponentSet {
  return { key, name, description: '', documentationLinks: [], remote: true };
}

// Text and boolean properties carry Figma's "#id" suffix. Variant properties do not.
function variant(value: string): ComponentProperty {
  return { type: 'VARIANT', value };
}
function textProperty(value: string): ComponentProperty {
  return { type: 'TEXT', value };
}

// The refresh control is icon only, so its accessible name comes from the Button Details card. The
// note on it is a Dev Mode annotation, which Figma's published node types do not spell out.
const refreshIcon: FrameNode & { annotations: FigmaAnnotation[] } = {
  ...frame('1:5', 'refresh-icon', box(160, 140, 32, 32), []),
  annotations: [{ label: "Spins while loading. Announce 'Refreshing'." }],
};

const mainArea = frame('1:2', 'Main area', box(0, 60, 1200, 700), [
  text('1:3', 'Users', box(40, 80, 120, 40)),
  text('1:4', 'Create user', box(40, 140, 110, 36)),
  refreshIcon,
  // Visually hidden label text for the row menu toggle.
  text('1:6', 'Actions for alice', box(1100, 220, 1, 1)),
]);

const usersFrame = frame('1:1', 'Users', box(0, 0, 1480, 800), [
  mainArea,
  stamp('2:1', 'Heading Stamp', '10:1', box(30, 88, 24, 24), { Level: variant('h1') }),
  stamp('2:2', 'Landmark Stamp', '11:1', box(0, 60, 24, 24), { Element: variant('main') }),
  stamp('2:3', 'Ordering Stamp', '12:1', box(30, 146, 24, 24), { 'Order ##7:3': textProperty('1') }),
  stamp('2:4', 'Ordering Stamp', '12:1', box(170, 130, 24, 24), { 'Order ##7:3': textProperty('2') }),
  stamp('2:5', 'Button Stamp', '13:1', box(182, 162, 24, 24), { 'Note number#9:1': textProperty('1') }),
  stamp('2:6', 'Ordering Stamp', '12:1', box(1090, 210, 24, 24), { 'Order ##7:3': textProperty('3') }),
  stamp('2:7', 'Button Details', '14:1', box(1220, 80, 240, 120), {
    'Note number#9:1': textProperty('1'),
    'Accessible Name#9:2': textProperty('Refresh'),
  }),
]);

const page: CanvasNode = {
  id: '0:1',
  name: 'Page 1',
  type: 'CANVAS',
  visible: true,
  scrollBehavior: 'SCROLLS',
  backgroundColor: { r: 0.96, g: 0.96, b: 0.96, a: 1 },
  prototypeStartNodeID: null,
  flowStartingPoints: [],
  prototypeDevice: { type: 'NONE', rotation: 'NONE' },
  children: [usersFrame],
};

const documentNode: DocumentNode = {
  id: '0:0',
  name: 'Document',
  type: 'DOCUMENT',
  visible: true,
  scrollBehavior: 'SCROLLS',
  children: [page],
};

export const usersScreen: GetFileResponse = {
  name: 'Users screen',
  role: 'viewer',
  lastModified: '2026-10-08T00:00:00Z',
  editorType: 'figma',
  version: '4242',
  schemaVersion: 0,
  document: documentNode,
  components: {
    '10:1': component('k-heading-h1', 'Level=h1', '10:0'),
    '11:1': component('k-landmark-main', 'Element=main', '11:0'),
    '12:1': component('k-ordering', 'Ordering Stamp', '12:0'),
    '13:1': component('k-button', 'Button Stamp', '13:0'),
    '14:1': component('k-button-details', 'Button Details', '14:0'),
  },
  componentSets: {
    '10:0': componentSet('ks-heading', 'Heading Stamp'),
    '11:0': componentSet('ks-landmark', 'Landmark Stamp'),
    '12:0': componentSet('ks-ordering', 'Ordering Stamp'),
    '13:0': componentSet('ks-button', 'Button Stamp'),
    '14:0': componentSet('ks-button-details', 'Button Details'),
  },
  styles: {},
};
