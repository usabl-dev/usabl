/**
 * `usabl import figma <file key> --frame <Frame name>=<surface id> --out <file>`: reads a Figma file
 * and writes a draft requirements file.
 *
 * Every requirement it writes starts with approved: false, so nothing blocks until a person reviews
 * it. It never overwrites a file, and it checks that the file it is about to write loads through
 * the normal loader with every requirement unapproved. The token is read from FIGMA_TOKEN only and
 * is never printed: every message passes through one place that removes it. Design notes are
 * printed inside an untrusted-text frame, because a model may read this output.
 */
import { writeFile } from 'node:fs/promises';
import { describeFileKeyProblem } from '../../intake/design-source.js';
import { normalize } from '../../intake/normalize.js';
import { describeRequirementIdProblem } from '../../intake/requirement-ids.js';
import { firstLine } from '../../primitives/first-line.js';
import { neutralize } from '../../primitives/neutralize.js';
import { frameUntrustedBlock, scrubString } from '../../surfaces/scrub.js';
import { bundleToYaml } from '../yaml.js';
import { figmaApiBase, FigmaFetchError, fetchFigmaFile } from './fetch.js';
import { FigmaImportError, importFigmaFile } from './import.js';

export interface ImportOutcome {
  exitCode: 0 | 2;
  stdout?: string;
  stderr?: string;
}

const USAGE =
  'usage: usabl import figma <file key> --frame <Frame name>=<surface id> [--frame ...] --out <file> [--owner <name>] [--min-target <css px>]';

const OWNER_LIMIT = 100;

interface ImportArgs {
  fileKey: string;
  frames: Record<string, string>;
  out: string;
  owner: string;
  minTarget?: number;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--frame', '--out', '--owner', '--min-target']);

// Unlike the main parser, this one refuses an unknown flag and a frame given twice, because either
// would silently drop a frame.
function parseImportArgs(args: readonly string[]): ImportArgs | string {
  const [source, fileKey, ...rest] = args;
  if (source !== 'figma') {
    return `usabl import: the only source is figma\n${USAGE}`;
  }
  if (fileKey === undefined || fileKey.startsWith('-')) {
    return `usabl import: give the Figma file key\n${USAGE}`;
  }
  const keyProblem = describeFileKeyProblem(fileKey);
  if (keyProblem !== null) {
    return `usabl import: the file key ${keyProblem}`;
  }
  const frames: Record<string, string> = {};
  let out: string | undefined;
  let owner = 'design';
  let minTarget: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? '';
    if (!VALUE_FLAGS.has(flag)) {
      return `usabl import: unknown option ${flag}\n${USAGE}`;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return `usabl import: ${flag} needs a value\n${USAGE}`;
    }
    index += 1;
    if (flag === '--frame') {
      const at = value.lastIndexOf('=');
      const name = at < 0 ? '' : value.slice(0, at).trim();
      const surface = at < 0 ? '' : value.slice(at + 1).trim();
      if (name === '' || surface === '') {
        return 'usabl import: --frame takes <Frame name>=<surface id>, such as --frame "Users list=users"';
      }
      const surfaceProblem = describeRequirementIdProblem(surface);
      if (surfaceProblem !== null) {
        return `usabl import: the surface id in --frame "${name}=..." ${surfaceProblem}`;
      }
      if (Object.hasOwn(frames, name)) {
        return `usabl import: the frame "${name}" is given in two --frame options. Give each frame once.`;
      }
      frames[name] = surface;
    } else if (flag === '--out') {
      out = value;
    } else if (flag === '--owner') {
      if (value.trim() === '' || neutralize(value) !== value || /\s{2,}|[\t\n\r]/u.test(value) || value.length > OWNER_LIMIT) {
        return `usabl import: --owner takes one line of plain text, at most ${OWNER_LIMIT} characters, such as --owner design`;
      }
      owner = value.trim();
    } else {
      const size = Number(value);
      if (!Number.isFinite(size) || size <= 0 || size > 200) {
        return 'usabl import: --min-target takes a size from 1 to 200 CSS pixels, such as --min-target 24';
      }
      minTarget = size;
    }
  }
  if (Object.keys(frames).length === 0) {
    return `usabl import: give at least one --frame\n${USAGE}`;
  }
  if (out === undefined) {
    return `usabl import: give --out\n${USAGE}`;
  }
  return { fileKey, frames, out, owner, ...(minTarget === undefined ? {} : { minTarget }) };
}

function quoted(names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
}

export async function runImportCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ImportOutcome> {
  const token = env['FIGMA_TOKEN'] ?? '';
  // Every message passes through here, so no path can print the token, a credential, or a
  // control sequence. The notes are framed after the token is removed, so the frame stays whole.
  const hideToken = (text: string): string => (token === '' ? text : text.split(token).join('[token]'));
  const render = (lines: readonly string[], notes: readonly string[] = []): string => {
    const safe = lines.flatMap((line) => hideToken(line).split('\n')).map((line) => scrubString(line));
    const block = notes.length === 0 ? [] : [frameUntrustedBlock(notes.map((note) => `  ${hideToken(note)}`))];
    return `${[...safe, ...block].join('\n')}\n`;
  };
  const fail = (lines: readonly string[], notes: readonly string[] = []): ImportOutcome => ({
    exitCode: 2,
    stderr: render(lines, notes),
  });

  const parsed = parseImportArgs(args);
  if (typeof parsed === 'string') {
    return fail([parsed]);
  }
  if (token === '') {
    return fail(['usabl import: Set FIGMA_TOKEN to a Figma personal access token that can read this file.']);
  }
  const base = figmaApiBase(env);
  if (!base.ok) {
    return fail([`usabl import: ${base.message}`]);
  }

  try {
    const file = await fetchFigmaFile(base.base, parsed.fileKey, token);
    const { bundle, notes, emptyFrames } = importFigmaFile(file, {
      fileKey: parsed.fileKey,
      frames: parsed.frames,
      owner: parsed.owner,
      ...(parsed.minTarget === undefined ? {} : { minTargetCssPx: parsed.minTarget }),
    });
    const notesLine = `${notes.length === 1 ? '1 Figma note was' : `${notes.length} Figma notes were`} not turned into a check${notes.length === 0 ? '.' : ':'}`;
    if (bundle.requirements.length === 0) {
      const which = emptyFrames.length === 1 ? `the frame ${quoted(emptyFrames)}` : `the frames ${quoted(emptyFrames)}`;
      return fail([`usabl import: ${which} gave no requirements, so there is nothing to write.`, notesLine], notes);
    }
    const yaml = bundleToYaml(bundle, {
      header: `Drafted by usabl import figma from ${parsed.fileKey} version ${file.version}.`,
    });
    // The file must load through the normal loader, and nothing in it may be approved, or a person
    // would review a file that cannot run or one that already blocks.
    const check = normalize(yaml);
    if (!check.ok) {
      return fail([`usabl import: the drafted requirements would not load: ${check.reason}`]);
    }
    if (check.bundle.requirements.some((requirement) => requirement.approved)) {
      return fail(['usabl import: a drafted requirement came out approved, so nothing was written.']);
    }
    await writeFile(parsed.out, yaml, { encoding: 'utf8', flag: 'wx' });
    const lines = [
      `Wrote ${plural(bundle.requirements.length, 'draft requirement', 'draft requirements')} to ${parsed.out}.`,
      ...emptyFrames.map((name) => `Warning: the frame "${name}" gave no requirements.`),
      notesLine,
    ];
    const next = 'Review each requirement, set approved: true, and commit. Nothing blocks until then.';
    return { exitCode: 0, stdout: `${render(lines, notes)}${render([next])}` };
  } catch (error: unknown) {
    if (error instanceof FigmaFetchError || error instanceof FigmaImportError) {
      return fail([`usabl import: ${error.message}`]);
    }
    const code = errorCode(error);
    if (code === 'EEXIST') {
      return fail([`usabl import: ${parsed.out} already exists. Choose another --out, or remove the file first.`]);
    }
    if (code !== null) {
      return fail([`usabl import: could not write ${parsed.out} (${code}). Check that its folder exists and can be written.`]);
    }
    const message = error instanceof Error ? firstLine(error.message) : '';
    return fail([`usabl import: the import stopped on an error, so nothing was written: ${message || 'no message'}`]);
  }
}
