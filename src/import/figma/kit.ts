/**
 * Recognizes accessibility annotation kit notes in a Figma file. The names follow the GitHub
 * Annotation Toolkit: Heading, Landmark, Ordering, and Button stamps, and Button Details cards.
 * Other notes of that kit, such as Image Stamps, are recognized too, so the importer can list them
 * as notes it did not turn into a check. Another kit can be added to KIT_COMPONENTS without
 * touching the importer. Names and property values are untrusted design text: this unit only
 * compares them and hands them back, and the importer neutralizes them before any output.
 */
import type { FigmaFile, FigmaNode } from './types.js';

export type StampKind = 'heading-stamp' | 'landmark-stamp' | 'ordering-stamp' | 'button-stamp' | 'button-details';

const KIT_COMPONENTS: Readonly<Record<string, StampKind>> = {
  'heading stamp': 'heading-stamp',
  'landmark stamp': 'landmark-stamp',
  'ordering stamp': 'ordering-stamp',
  'button stamp': 'button-stamp',
  'button details': 'button-details',
};

// A file's own maps are read only for keys they hold themselves, so a key such as "constructor"
// in a design file never reaches an inherited property.
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

// Kits often start component names with a marker such as "❖", so leading symbols are dropped.
function displayName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function normalizeName(name: string): string {
  return displayName(name).toLowerCase();
}

// How a kit note is recognized, including kinds usabl does not read: an instance whose component
// name ends in "Stamp" or "Details", as every note of the GitHub Annotation Toolkit does. The
// component set name wins, since variant names such as "Level=h1" say nothing about the kit. When
// the file lists no component for the instance, its own layer name is used. Only instances count,
// because a plain frame or text layer that a designer happens to call "Order Details" is design
// content. A design component named that way would be read as a kit note, but the importer then
// lists it, so the mistake is visible and never silent.
const KIT_NAME = /(^|\s)(stamp|details)$/u;

export interface KitNote {
  kind: StampKind | null; // null for a kit note usabl does not turn into a check
  label: string; // the kit's name for the note, such as "Image Stamp"
}

export function kitNote(node: FigmaNode, file: Pick<FigmaFile, 'components' | 'componentSets'>): KitNote | null {
  if (node.type !== 'INSTANCE') {
    return null;
  }
  const meta = node.componentId === undefined ? undefined : own(file.components, node.componentId);
  const setName = meta?.componentSetId === undefined ? undefined : own(file.componentSets, meta.componentSetId)?.name;
  const name = setName ?? meta?.name ?? node.name;
  const key = normalizeName(name);
  if (!KIT_NAME.test(key)) {
    return null;
  }
  return { kind: own(KIT_COMPONENTS, key) ?? null, label: displayName(name) };
}

export function stampKind(node: FigmaNode, file: Pick<FigmaFile, 'components' | 'componentSets'>): StampKind | null {
  return kitNote(node, file)?.kind ?? null;
}

/**
 * The value of a component property by its name, or null. Text and boolean properties carry a
 * "#id" suffix in Figma's API, as in "Order ##7:3", and variant properties do not, so both forms
 * match. Names compare without case.
 */
export function propertyValue(node: FigmaNode, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, property] of Object.entries(node.componentProperties ?? {})) {
    const base = key.replace(/#[^#]*$/u, '').trim().toLowerCase();
    const plain = key.trim().toLowerCase();
    if (base === wanted || plain === wanted) {
      return String(property.value);
    }
  }
  return null;
}
