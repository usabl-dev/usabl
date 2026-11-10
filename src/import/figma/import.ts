/**
 * Turns a Figma design file into draft usabl requirements. Pure: no network and no file system.
 *
 * Every requirement starts unapproved and records the Figma file, node, and version it came from.
 * A stamp is linked to the design element it covers by overlap, and that element's text becomes the
 * accessible name to look for. Every note the importer cannot turn into a check is returned as a
 * note that says why, so nothing a designer wrote is dropped without a word.
 *
 * Every string in the file is untrusted design text. Names are neutralized and kept to one line
 * before they reach a requirement, and a name that is too long, or holds something the scrubber
 * would change, such as a credential or a frame marker, is listed as a note instead. Layer names
 * and note text quoted in a note are neutralized, bounded, and scrubbed. Design text is compared and
 * copied as data only: it never builds a path, a selector, or a command.
 */
import type {
  HeadingAssertion,
  LandmarkRole,
  Requirement,
  RequirementBundle,
  RequirementKind,
} from '../../contracts/index.js';
import { describeFileKeyProblem, describeNodeIdProblem, describeVersionProblem } from '../../intake/design-source.js';
import { describeRequirementIdProblem } from '../../intake/requirement-ids.js';
import { boundText } from '../../output/bounded-text.js';
import { collapseWhiteSpace } from '../../primitives/accessible-name.js';
import { neutralize } from '../../primitives/neutralize.js';
import { scrubString } from '../../surfaces/scrub.js';
import { kitNote, propertyIsSlot, propertyValue, type StampKind } from './kit.js';
import type { FigmaFile, FigmaNode, FigmaRect } from './types.js';

export interface FigmaImportOptions {
  fileKey: string;
  frames: Record<string, string>; // Figma frame name -> usabl surface id, in the order given
  owner: string;
  minTargetCssPx?: number;
}

export interface FigmaImportResult {
  bundle: RequirementBundle;
  // One line per design note that was not turned into a check, already neutralized and scrubbed.
  notes: string[];
  emptyFrames: string[]; // mapped frames that gave no requirement, in the order they were given
}

/** A file or an option the importer cannot work from. The message names what to fix. */
export class FigmaImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigmaImportError';
  }
}

const ELEMENT_TO_LANDMARK: Readonly<Record<string, LandmarkRole>> = {
  main: 'main',
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  section: 'region',
  form: 'form',
  search: 'search',
};

const HEADING_LEVELS: Readonly<Record<string, HeadingAssertion['level']>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

// The longest accessible name the importer copies into a requirement.
const NAME_LIMIT = 200;
// How much of a layer name, or of a note's text, a note quotes.
const QUOTE_LIMIT = 80;
const NOTE_TEXT_LIMIT = 300;

// Design text as one line, for a note or a stamp value: the characters that make a display lie are
// removed, and every run of white space is one space. Names use readName, which keeps a no-break
// space as the page does.
function oneLine(raw: string): string {
  return neutralize(raw).replace(/\s+/gu, ' ').trim();
}

// A layer name or a value, shortened and quoted for a note.
function quote(raw: string): string {
  return `"${boundText(oneLine(raw), QUOTE_LIMIT)}"`;
}

type NameRead = { ok: true; name: string } | { ok: false; reason: string };

// Why a stamp linked to a Button Details card whose name usabl cannot read gives no name.
const UNREAD_CARD = 'its Button Details card gives no accessible name usabl can read, and the layer text is not used in its place';
// Why a stamp whose note number is on a readable card and on an unreadable one gives no name.
const UNCLEAR_CARD =
  'its note number is on more than one Button Details card, and usabl cannot read the name on one of them, so which name the designer meant is unknown';

// Design text read as an accessible name. The characters that make a display lie are removed, and
// white space is collapsed with the same rule the page match uses: ASCII white space only. So a
// no-break space in the design stays where the page keeps it, and the two names can still match.
function readName(raw: string | undefined): NameRead {
  const name = collapseWhiteSpace(neutralize(raw ?? ''));
  // Text that is only white space, of any kind, is no name.
  if (name.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  if (name.length > NAME_LIMIT) {
    return { ok: false, reason: `its text is longer than ${NAME_LIMIT} characters, so usabl does not copy it as an accessible name` };
  }
  if (scrubString(name) !== name) {
    return {
      ok: false,
      reason: 'its text holds something usabl does not copy into a requirement, such as a credential or a frame marker',
    };
  }
  return { ok: true, name };
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function overlapArea(a: FigmaRect, b: FigmaRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

// The design element a stamp annotates: the node whose own area the stamp covers most, preferring
// text. Scoring by the share of the candidate covered, not by raw overlap, keeps a large container
// such as "Main area" from winning every stamp placed inside it. A tie keeps the earlier node in
// document order, so the answer never depends on anything but the file.
function coveredNode(stamp: FigmaNode, candidates: readonly FigmaNode[]): FigmaNode | null {
  const box = stamp.absoluteBoundingBox;
  if (box === undefined || box === null) {
    return null;
  }
  let best: { node: FigmaNode; score: number } | null = null;
  for (const node of candidates) {
    const nodeBox = node.absoluteBoundingBox;
    if (nodeBox === undefined || nodeBox === null) {
      continue;
    }
    const area = overlapArea(box, nodeBox);
    if (area === 0) {
      continue;
    }
    const ownArea = Math.max(nodeBox.width * nodeBox.height, 1);
    const score = (area / ownArea) * (node.type === 'TEXT' ? 4 : 1);
    if (best === null || score > best.score) {
      best = { node, score };
    }
  }
  return best?.node ?? null;
}

function findFrame(file: FigmaFile, name: string): FigmaNode | null {
  for (const canvas of file.document.children ?? []) {
    if (canvas.type !== 'CANVAS') {
      continue;
    }
    const frame = (canvas.children ?? []).find((node) => node.type === 'FRAME' && node.name === name);
    if (frame !== undefined) {
      return frame;
    }
  }
  return null;
}

// Every design note the importer does not turn into a check is reported in this one form, so a
// person can see each note that was left out and why. The whole line is scrubbed, because it
// quotes design text.
function notConverted(what: string, reason: string): string {
  return scrubString(`${what} was not turned into a check: ${/[.!?]$/u.test(reason) ? reason : `${reason}.`}`);
}

interface Stamp {
  node: FigmaNode;
  kind: StampKind;
  covers: FigmaNode | null;
}

interface UnknownNote {
  node: FigmaNode;
  label: string;
  covers: FigmaNode | null;
}

// Collects what one frame says. Stamps are kept in document order, which sets the id numbering.
// Every kit note, read or not, is left out of the design elements a stamp can link to, so a stamp
// never links to another note.
function readFrame(frame: FigmaNode, file: FigmaFile): { stamps: Stamp[]; unknown: UnknownNote[]; annotated: FigmaNode[] } {
  const known: Array<{ node: FigmaNode; kind: StampKind }> = [];
  const unknownNodes: Array<{ node: FigmaNode; label: string }> = [];
  const candidates: FigmaNode[] = [];
  const annotated: FigmaNode[] = [];
  const visit = (node: FigmaNode, inNote: boolean): void => {
    if ((node.annotations ?? []).length > 0) {
      annotated.push(node);
    }
    const note = kitNote(node, file);
    if (note !== null && note.kind !== null) {
      known.push({ node, kind: note.kind });
    } else if (note !== null) {
      unknownNodes.push({ node, label: note.label });
    } else if (!inNote && node !== frame && node.absoluteBoundingBox) {
      candidates.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child, inNote || note !== null);
    }
  };
  visit(frame, false);
  const stamps = known.map((stamp) => ({ ...stamp, covers: coveredNode(stamp.node, candidates) }));
  const unknown = unknownNodes.map((note) => ({ ...note, covers: coveredNode(note.node, candidates) }));
  return { stamps, unknown, annotated };
}

interface OrderedStamp {
  order: number;
  name: string;
  stamp: FigmaNode;
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 2) {
    return `both ${quoted[0]} and ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

type FocusOrderPlan =
  | { ok: true; first: OrderedStamp; sequence: string[] }
  | { ok: false; what: string; reason: string }
  | null; // no ordering stamps in the frame

// A focus order needs two or more stamps, each with its own number and its own name. Document
// order never breaks a tie, because the order of layers in Figma does not say what comes first.
function planFocusOrder(ordered: readonly OrderedStamp[], frameName: string): FocusOrderPlan {
  const sorted = [...ordered].sort((a, b) => a.order - b.order);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }
  if (sorted.length === 1) {
    return { ok: false, what: `Ordering stamp ${first.order} on "${first.name}"`, reason: 'one ordering stamp cannot define an order' };
  }
  const what = `The focus order in frame ${quote(frameName)}`;
  const tie = sorted.find((entry, index) => sorted[index + 1]?.order === entry.order);
  if (tie !== undefined) {
    const names = quotedList(ordered.filter((entry) => entry.order === tie.order).map((entry) => entry.name));
    return { ok: false, what, reason: `order ${tie.order} is on ${names}, so the order is unclear` };
  }
  const sequence = sorted.map((entry) => entry.name);
  const repeated = sequence.find((name, index) => sequence.indexOf(name) !== index);
  if (repeated !== undefined) {
    return { ok: false, what, reason: `"${repeated}" appears more than once, and a focus order check needs each name once` };
  }
  return { ok: true, first, sequence };
}

function checkOptions(file: FigmaFile, options: FigmaImportOptions): void {
  const keyProblem = describeFileKeyProblem(options.fileKey);
  if (keyProblem !== null) {
    throw new FigmaImportError(`The file key ${keyProblem}.`);
  }
  if (describeVersionProblem(file.version) !== null) {
    throw new FigmaImportError('The Figma file has a version usabl cannot record, so no requirement could say which version it came from.');
  }
  for (const surface of Object.values(options.frames)) {
    const problem = describeRequirementIdProblem(surface);
    if (problem !== null) {
      throw new FigmaImportError(`A surface id given with --frame ${problem}`);
    }
  }
}

export function importFigmaFile(file: FigmaFile, options: FigmaImportOptions): FigmaImportResult {
  checkOptions(file, options);
  const requirements: Requirement[] = [];
  const notes: string[] = [];
  const counts = new Map<string, number>();
  const emptyFrames: string[] = [];

  for (const [frameName, surface] of Object.entries(options.frames)) {
    const frame = findFrame(file, frameName);
    if (frame === null) {
      throw new FigmaImportError(`The Figma file has no frame named ${quote(frameName)}.`);
    }
    const { stamps, unknown, annotated } = readFrame(frame, file);
    const before = requirements.length;

    // The layer a note is about, for the notes below: the element a stamp covers when it covers one.
    const targetOf = (stamp: Stamp): string => quote(stamp.covers?.name ?? stamp.node.name);

    const add = (kind: RequirementKind, stamp: FigmaNode, description: string, assertion: Requirement['assertion']): void => {
      const counter = `${surface}:${kind}`;
      const n = (counts.get(counter) ?? 0) + 1;
      counts.set(counter, n);
      requirements.push({
        id: `figma-${surface}-${kind}-${n}`,
        kind,
        surface,
        description,
        assertion,
        owner: options.owner,
        approved: false,
        source: { tool: 'figma', file: options.fileKey, node: stamp.id, version: file.version },
      });
    };

    // A stamp whose node id usabl cannot record could not be traced back to the design, so it is
    // listed and not used.
    const usable = stamps.filter((stamp) => {
      if (describeNodeIdProblem(stamp.node.id) === null) {
        return true;
      }
      notes.push(notConverted(`A kit note on ${targetOf(stamp)}`, 'its node id is not one usabl can record'));
      return false;
    });

    // Button Details cards carry the accessible name, linked to a Button Stamp by note number. A
    // card that links to no stamp, or that repeats a note number, is listed and not used.
    const stampNotes = new Set<string>();
    for (const stamp of usable) {
      const note = stamp.kind === 'button-stamp' ? propertyValue(stamp.node, 'Note number')?.trim() : undefined;
      if (note !== undefined && note !== '') {
        stampNotes.add(note);
      }
    }
    const detailNames = new Map<string, string>();
    // The note numbers of cards whose name usabl cannot read. A stamp with one of them and no
    // readable card is listed, because its layer text is not the name the designer gave.
    const unreadNotes = new Set<string>();
    // The note numbers that a readable card and an unreadable card share. Which name the designer
    // meant is a guess, so neither card is used, and the stamp is listed.
    const unclearNotes = new Set<string>();
    const cards = usable
      .filter((stamp) => stamp.kind === 'button-details')
      .map((stamp) => ({
        stamp,
        note: propertyValue(stamp.node, 'Note number')?.trim() ?? '',
        read: propertyIsSlot(stamp.node, 'Accessible Name')
          ? ({ ok: false, reason: 'its Accessible Name is a slot, which holds a layer and not text, so usabl cannot read the name' } as const)
          : readName(propertyValue(stamp.node, 'Accessible Name') ?? undefined),
      }));
    for (const { note, read } of cards) {
      if (!read.ok && note !== '') {
        unreadNotes.add(note);
      }
    }
    for (const { stamp, note, read } of cards) {
      if (!read.ok) {
        const reason = read.reason === 'empty' ? 'it has no accessible name' : read.reason;
        notes.push(notConverted(`Button Details in layer ${quote(stamp.node.name)}`, reason));
        continue;
      }
      const card = `Button Details for "${read.name}"`;
      const used = detailNames.get(note);
      if (note === '') {
        notes.push(notConverted(card, 'it has no note number, so it matches no Button Stamp'));
      } else if (unreadNotes.has(note)) {
        unclearNotes.add(note);
        notes.push(
          notConverted(card, `note number ${quote(note)} is also on a Button Details card whose name usabl cannot read, so which name the designer meant is unknown`),
        );
      } else if (used !== undefined) {
        notes.push(notConverted(card, `note number ${quote(note)} is already used by Button Details for "${used}"`));
      } else if (!stampNotes.has(note)) {
        detailNames.set(note, read.name);
        notes.push(notConverted(card, `no Button Stamp has note number ${quote(note)}`));
      } else {
        detailNames.set(note, read.name);
      }
    }

    // The text a stamp covers, as an accessible name, or why it gives none.
    const coveredName = (stamp: Stamp): NameRead => readName(stamp.covers?.characters);

    // The accessible name of each button-stamped design element, so an ordering stamp on the same
    // element uses the name a screen reader hears and not the layer's text.
    const stampNames = new Map<FigmaNode, NameRead>();
    const buttonNames = new Map<string, NameRead>();
    for (const stamp of usable) {
      if (stamp.kind !== 'button-stamp') {
        continue;
      }
      const note = propertyValue(stamp.node, 'Note number')?.trim();
      const detail = note === undefined ? undefined : detailNames.get(note);
      const read: NameRead =
        note !== undefined && unclearNotes.has(note)
          ? { ok: false, reason: UNCLEAR_CARD }
          : detail !== undefined
            ? { ok: true, name: detail }
            : note !== undefined && unreadNotes.has(note)
              ? { ok: false, reason: UNREAD_CARD }
              : coveredName(stamp);
      stampNames.set(stamp.node, read);
      if (stamp.covers !== null && (read.ok || read.reason === UNREAD_CARD || read.reason === UNCLEAR_CARD)) {
        buttonNames.set(stamp.covers.id, read);
      }
    }

    const ordered: OrderedStamp[] = [];
    for (const stamp of usable) {
      const target = targetOf(stamp);
      switch (stamp.kind) {
        case 'heading-stamp': {
          const raw = oneLine(propertyValue(stamp.node, 'Level') ?? '').toLowerCase();
          const level = own(HEADING_LEVELS, raw);
          const read = coveredName(stamp);
          if (/[+\-↑↓]/u.test(raw)) {
            notes.push(notConverted(`Heading stamp on ${target}`, 'it uses a relative level, so write the level by hand'));
          } else if (level === undefined) {
            notes.push(notConverted(`Heading stamp on ${target}`, `usabl does not read level ${quote(raw)}`));
          } else if (!read.ok) {
            const reason = read.reason === 'empty' ? 'it covers no text, so the heading name is unknown' : read.reason;
            notes.push(notConverted(`Heading stamp on ${target}`, reason));
          } else {
            add('heading', stamp.node, `The heading "${read.name}" is level ${level}, as in the design.`, {
              type: 'heading',
              name: read.name,
              level,
            });
          }
          break;
        }
        case 'landmark-stamp': {
          const raw = oneLine(propertyValue(stamp.node, 'Element') ?? '').replace(/[<>]/gu, '').trim().toLowerCase();
          const role = own(ELEMENT_TO_LANDMARK, raw);
          if (role === undefined) {
            notes.push(notConverted(`Landmark stamp on ${target}`, `usabl does not map element ${quote(raw)} to a landmark`));
          } else {
            add('landmark', stamp.node, `The screen has a ${role} landmark, as in the design.`, { type: 'landmark', role });
          }
          break;
        }
        case 'button-stamp': {
          const read = stampNames.get(stamp.node);
          if (read === undefined || !read.ok) {
            const reason =
              read === undefined || read.reason === 'empty'
                ? 'the design gives no accessible name, so add Button Details with one'
                : read.reason;
            notes.push(notConverted(`Button stamp on ${target}`, reason));
            break;
          }
          add('name', stamp.node, `A button is named "${read.name}", as in the design.`, {
            type: 'name',
            target: { role: 'button', name: read.name },
          });
          if (options.minTargetCssPx !== undefined) {
            const min = options.minTargetCssPx;
            add('target-size', stamp.node, `The button "${read.name}" is at least ${min} by ${min} CSS pixels.`, {
              type: 'target-size',
              target: { role: 'button', name: read.name },
              minCssPx: min,
            });
          }
          break;
        }
        case 'ordering-stamp': {
          const raw = oneLine(propertyValue(stamp.node, 'Order #') ?? '');
          const order = /^\d{1,6}$/u.test(raw) ? Number.parseInt(raw, 10) : null;
          const button = stamp.covers === null ? undefined : buttonNames.get(stamp.covers.id);
          const read: NameRead = button ?? coveredName(stamp);
          if (order === null) {
            notes.push(notConverted(`Ordering stamp on ${target}`, `its order ${quote(raw)} is not a whole number`));
          } else if (!read.ok) {
            const reason = read.reason === 'empty' ? 'it covers no text, so its name is unknown' : read.reason;
            notes.push(notConverted(`Ordering stamp ${order} on ${target}`, reason));
          } else {
            ordered.push({ order, name: read.name, stamp: stamp.node });
          }
          break;
        }
        case 'button-details':
          break;
      }
    }

    const plan = planFocusOrder(ordered, frameName);
    if (plan !== null && !plan.ok) {
      notes.push(notConverted(plan.what, plan.reason));
    } else if (plan !== null) {
      add(
        'focus-order',
        plan.first.stamp,
        `Focus reaches ${plan.sequence.map((name) => `"${name}"`).join(', ')} in that order, as in the design.`,
        { type: 'focus-order', sequence: plan.sequence },
      );
    }

    // A details card sits beside the design, so it is named by its own layer. A stamp sits on the
    // element it annotates, so it is named by that element when it covers one.
    for (const note of unknown) {
      const where = /details$/iu.test(note.label)
        ? `in layer ${quote(note.node.name)}`
        : `on ${quote(note.covers?.name ?? note.node.name)}`;
      notes.push(notConverted(`${oneLine(note.label)} ${where}`, 'usabl does not read this kind of kit note'));
    }

    // Dev Mode notes are free text, so none is turned into a check. Each is listed with its text.
    for (const node of annotated) {
      for (const annotation of node.annotations ?? []) {
        const text = oneLine(annotation.label ?? '') || oneLine(annotation.labelMarkdown ?? '');
        const reason =
          text === ''
            ? 'the note has no text to check'
            : `usabl does not read Dev Mode notes. The note says: ${boundText(text, NOTE_TEXT_LIMIT)}`;
        notes.push(notConverted(`Figma note on ${quote(node.name)}`, reason));
      }
    }
    if (requirements.length === before) {
      emptyFrames.push(oneLine(frameName));
    }
  }

  return { bundle: { version: 1, requirements }, notes, emptyFrames };
}
