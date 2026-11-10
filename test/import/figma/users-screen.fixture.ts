/**
 * A mock Figma design file for a Users screen, as GET /v1/files/:key returns it. The accessibility
 * notes follow the kit in src/import/figma/kit.ts: stamps are component instances placed over the design
 * element they annotate, and coordinates are absolute, as in the API.
 *
 * The file is written to match Figma's published file format by hand: it carries the fields that
 * format lists as required for each node type, filled with plain defaults, so it is meant to be a
 * file Figma could send and not only the subset usabl reads. The types below spell those fields
 * out. Nothing in this repository checks them against Figma's own package yet.
 */
import type {
  FigmaAnnotation,
  FigmaComponentProperty,
  FigmaFile,
  FigmaNode,
  FigmaRect,
  FigmaSlotContentId,
} from '../../../src/import/figma/types.js';

// The fields Figma's types require on every node, and on frames, instances, and text.
interface SpecNode extends FigmaNode {
  visible: boolean;
  scrollBehavior: 'SCROLLS';
}
interface SpecLayer extends SpecNode {
  blendMode: 'PASS_THROUGH';
  absoluteRenderBounds: FigmaRect;
  fills: never[];
  strokes: never[];
  effects: never[];
}
interface SpecText extends SpecLayer {
  characters: string;
  style: Record<string, never>;
  characterStyleOverrides: never[];
  styleOverrideTable: Record<string, never>;
  lineTypes: Array<'NONE'>;
  lineIndentations: number[];
}
interface SpecFrame extends SpecLayer {
  children: FigmaNode[];
  clipsContent: boolean;
}
interface SpecInstance extends SpecFrame {
  componentId: string;
  componentProperties: Record<string, FigmaComponentProperty>;
  overrides: never[];
}
// A slot property, as Figma's types allow on an instance: its value is an id for the slot's
// content, never text.
interface SpecSlotProperty extends FigmaComponentProperty {
  type: 'SLOT';
  value: FigmaSlotContentId;
}
interface SpecComponent {
  key: string;
  name: string;
  description: string;
  componentSetId: string;
  documentationLinks: never[];
  remote: boolean;
}
interface SpecComponentSet {
  key: string;
  name: string;
  description: string;
  documentationLinks: never[];
  remote: boolean;
}
interface SpecFile extends FigmaFile {
  role: 'viewer';
  editorType: 'figma';
  schemaVersion: number;
  styles: Record<string, never>;
  components: Record<string, SpecComponent>;
  componentSets: Record<string, SpecComponentSet>;
}

function box(x: number, y: number, width: number, height: number): FigmaRect {
  return { x, y, width, height };
}

function layer(id: string, name: string, type: string, rect: FigmaRect): SpecLayer {
  return {
    id,
    name,
    type,
    visible: true,
    scrollBehavior: 'SCROLLS',
    blendMode: 'PASS_THROUGH',
    absoluteBoundingBox: rect,
    absoluteRenderBounds: rect,
    fills: [],
    strokes: [],
    effects: [],
  };
}

function text(id: string, characters: string, rect: FigmaRect): SpecText {
  return {
    ...layer(id, characters, 'TEXT', rect),
    characters,
    style: {},
    characterStyleOverrides: [],
    styleOverrideTable: {},
    lineTypes: ['NONE'],
    lineIndentations: [0],
  };
}

function frame(id: string, name: string, rect: FigmaRect, children: FigmaNode[]): SpecFrame {
  return { ...layer(id, name, 'FRAME', rect), children, clipsContent: false };
}

function stamp(
  id: string,
  name: string,
  componentId: string,
  rect: FigmaRect,
  componentProperties: Record<string, FigmaComponentProperty>,
): SpecInstance {
  return { ...frame(id, name, rect, []), type: 'INSTANCE', componentId, componentProperties, overrides: [] };
}

function component(key: string, name: string, componentSetId: string): SpecComponent {
  return { key, name, description: '', componentSetId, documentationLinks: [], remote: true };
}

function componentSet(key: string, name: string): SpecComponentSet {
  return { key, name, description: '', documentationLinks: [], remote: true };
}

// Text and boolean properties carry Figma's "#id" suffix. Variant properties do not.
function variant(value: string): FigmaComponentProperty {
  return { type: 'VARIANT', value };
}
function textProperty(value: string): FigmaComponentProperty {
  return { type: 'TEXT', value };
}
function slotProperty(sessionID: number, localID: number): SpecSlotProperty {
  return { type: 'SLOT', value: { guid: { sessionID, localID } } };
}

/**
 * An instance whose component has a slot property named "Content", for tests that add it to a copy
 * of the mock file. The mock file itself holds none, so the import of it is unchanged.
 */
export function slotInstance(id: string): SpecInstance {
  return stamp(id, 'Card', '13:1', box(0, 0, 100, 100), { 'Content#9:9': slotProperty(1, 2) });
}

// The refresh control is icon only, so its accessible name comes from the Button Details card.
const refreshIcon: SpecFrame & { annotations: FigmaAnnotation[] } = {
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

interface SpecCanvas extends SpecNode {
  children: FigmaNode[];
  backgroundColor: { r: number; g: number; b: number; a: number };
  prototypeStartNodeID: null;
  flowStartingPoints: never[];
  prototypeDevice: { type: 'NONE'; rotation: 'NONE' };
}

const page: SpecCanvas = {
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

const documentNode: SpecNode & { children: FigmaNode[] } = {
  id: '0:0',
  name: 'Document',
  type: 'DOCUMENT',
  visible: true,
  scrollBehavior: 'SCROLLS',
  children: [page],
};

export const usersScreen: SpecFile = {
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
