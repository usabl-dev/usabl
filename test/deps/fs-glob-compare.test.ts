/**
 * The adapter's glob against Node's own fs.glob, on real temporary folder trees. The trees hold
 * dot names, nested folders, long names, unicode, and links. The patterns are of the kinds each
 * caller passes: guardedPaths entries and the guard's dot listings, uiFileGlobs and wide-blast
 * globs, workspaces patterns, and fixed internal patterns.
 *
 * The adapter must list every file Node lists. It may list more only in the cases named in
 * WIDER_CASES, where the wider answer is the safe one, and it does not run a pattern past the bound
 * (see FS_GLOB_BOUND). FS_GLOB_COMPARE_ROUNDS and FS_GLOB_COMPARE_SEED make a longer or different
 * run; the default is a fast sample.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fsGlobBoundProblem } from '../../src/deps/fs-glob-reading.js';
import { makeFsGlob } from '../../src/deps/fs.js';

// What the adapter returned before: Node's answer, files only, relative to the folder.
async function nodeAnswer(cwd: string, pattern: string): Promise<string[]> {
  const seen = new Set<string>();
  for await (const entry of glob(pattern, { cwd, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    seen.add(relative(cwd, resolve(entry.parentPath, entry.name)));
  }
  return [...seen].sort();
}

// A small fixed-seed generator, so every run makes the same trees and patterns.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'a', 'b', 'ab', 'ba', 'aab', 'A', 'B', 'src', 'SRC', '.a', '.b', '.env', '.git', 'a.ts', 'b.tsx',
  'a.test.tsx', 'package.json', 'é', 'aé', '😀', 'a😀', 'a{b}', 'a,b', '$x', '${a,b}', '#c', '!n',
  'x y', 'a\nb', 'a'.repeat(40), `${'a'.repeat(30)}b`, `.${'a'.repeat(20)}`, 'a'.repeat(200),
];

interface Tree {
  files: string[];
  links: Array<{ path: string; target: string }>;
}

function makeTree(next: () => number): Tree {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const files = new Set<string>();
  const dirs = new Set<string>(['']);
  const count = 6 + Math.floor(next() * 14);
  for (let i = 0; i < count; i += 1) {
    const depth = 1 + Math.floor(next() * 4);
    const parts: string[] = [];
    for (let d = 0; d < depth; d += 1) parts.push(pick(NAMES));
    const path = parts.join('/');
    // A name cannot be both a file and a folder.
    const prefixes = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    if (prefixes.some((prefix) => files.has(prefix)) || dirs.has(path)) continue;
    files.add(path);
    for (const prefix of prefixes) dirs.add(prefix);
  }
  const links: Array<{ path: string; target: string }> = [];
  const dirList = [...dirs].filter((dir) => dir !== '');
  const fileList = [...files];
  for (let i = 0; i < 2; i += 1) {
    if (next() < 0.5) continue;
    const name = pick(['link', 'L', '.link', 'a-link']);
    const parent = pick(['', ...dirList]);
    const path = parent === '' ? name : `${parent}/${name}`;
    if (files.has(path) || dirs.has(path) || links.some((link) => link.path === path)) continue;
    if (parts(path).some((_, index) => files.has(parts(path).slice(0, index + 1).join('/')))) continue;
    const target = next() < 0.6 && dirList.length > 0 ? pick(dirList) : pick(fileList);
    if (target === undefined) continue;
    links.push({ path, target });
  }
  return { files: fileList, links };
}

function parts(path: string): string[] {
  return path.split('/');
}

async function buildTree(root: string, tree: Tree): Promise<void> {
  for (const file of tree.files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), '');
  }
  for (const link of tree.links) {
    await mkdir(dirname(join(root, link.path)), { recursive: true });
    await symlink(relative(dirname(join(root, link.path)), join(root, link.target)) || '.', join(root, link.path));
  }
}

// Parts of the kinds the callers write. Each wildcard part holds at most three runs of `*`, so
// Node itself answers quickly on these names.
const PARTS = [
  '**', '**', '*', '*', 'a*', '*a', '*b', '*.ts', '*.tsx', '*.{ts,tsx}', '{a,b}', '{a,.a}', '{src,SRC}',
  '.a', '.*', '.a*', 'a', 'b', 'ab', 'src', 'A', '?', 'a?', '?b', '??', '?*', '*?', '*a*b*', 'é', '😀',
  '{x}', 'a{b}', '${a,b}', '#c', '!n', 'x y', 'a,b', '.git', 'package.json', '*.test.*', '{,a}',
  `${'*a'.repeat(3)}`, '.env*', '[a]*', '[!a]', 'a\nb', 'a\n*',
];

// A pattern made from a file the tree holds, with some of its names written as wildcards, so many
// patterns match something.
function patternFrom(next: () => number, file: string): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const names = parts(file);
  const written: string[] = [];
  for (const name of names) {
    const roll = next();
    if (roll < 0.4) written.push(name);
    else if (roll < 0.5) written.push(name.startsWith('.') ? '.*' : '*');
    else if (roll < 0.6) written.push(`${name.slice(0, 1)}*`);
    else if (roll < 0.7) written.push(`*${name.slice(-1)}`);
    else if (roll < 0.75) written.push(`${name.slice(0, 1)}?${name.length > 2 ? '*' : ''}`);
    else if (roll < 0.8) written.push(`{${name},zz}`);
    else if (roll < 0.9) {
      if (written[written.length - 1] !== '**') written.push('**');
    } else written.push(pick(PARTS));
  }
  const pattern = written.join('/');
  return next() < 0.2 ? `${parts(pattern).slice(0, -1).join('/') || '.'}/**` : pattern;
}

function makePattern(next: () => number, tree: Tree): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  if (next() < 0.4 && tree.files.length > 0) return patternFrom(next, pick(tree.files)).replace(/^\{,/u, 'a/{,');
  const kind = next();
  const depth = 1 + Math.floor(next() * 4);
  const body: string[] = [];
  for (let d = 0; d < depth; d += 1) body.push(pick(PARTS));
  // A pattern whose first brace alternative is empty, such as `{,a}/x`, expands to `/x`, which
  // would walk the whole machine.
  if (body[0] === '{,a}') body[0] = 'a';
  let pattern = body.join('/');
  if (kind < 0.15) {
    // The guard's listings for one entry.
    return pick([pattern, `${pattern}/**`, `${pattern}/**/.*`, `${pattern}/**/.*/**`]);
  }
  if (kind < 0.25) return `${pattern}/package.json`;
  if (kind < 0.3) return pick(['**', '**/.*', '**/.*/**', '.*', `${pick(NAMES)}/.*`]);
  const shape = next();
  if (shape < 0.08) pattern = `./${pattern}`;
  else if (shape < 0.14) pattern = `${pattern}/`;
  else if (shape < 0.18) pattern = pattern.replace('/', '//');
  else if (shape < 0.22) pattern = pattern.replace('/', '/./');
  else if (shape < 0.26) pattern = `${pattern}/../${pick(PARTS)}`;
  else if (shape < 0.29) pattern = pattern.replace('/', '\\');
  return pattern;
}

/**
 * The cases where the adapter lists a file Node does not, and why that is the safe direction:
 * - through-link: the path passes a link to a folder at a part Node's walk does not follow
 *   there. Node follows a link at a fixed part but not at `**` or at a wildcard part, and in a few
 *   walks it follows one at the part after `**`. The adapter tests the path's names, so a file the
 *   wide walk reaches through the link is listed. Node also merges brace expansions such as
 *   `{link,*}` into one wildcard part, which then does not follow the link; the adapter walks
 *   each expansion.
 * - file-before-trailing-globstar: a pattern that ends with a slash and `**` names a file the
 *   part before them matches. Node lists that file only in some walks (when that part is fixed
 *   text it reaches with no `**` before it), and the adapter always lists it.
 */
const WIDER_CASES = ['through-link', 'file-before-trailing-globstar'] as const;

async function widerCase(root: string, tree: Tree, pattern: string, path: string): Promise<(typeof WIDER_CASES)[number] | null> {
  const names = parts(path);
  for (let index = 0; index < names.length - 1; index += 1) {
    const above = names.slice(0, index + 1).join('/');
    if (tree.links.some((link) => link.path === above)) return 'through-link';
  }
  if (pattern.endsWith('/**') && (await nodeAnswer(root, pattern.slice(0, -3))).includes(path)) {
    return 'file-before-trailing-globstar';
  }
  return null;
}

// Whether a pattern holds syntax the filter does not read: a class, an extglob group, or braces
// that are not single closed groups.
function otherSyntax(pattern: string): boolean {
  if (/[[\]]|[?*+@!]\(/u.test(pattern)) return true;
  let open = false;
  for (const char of pattern) {
    if (char === '{') {
      if (open) return true;
      open = true;
    } else if (char === '}') {
      if (!open) return true;
      open = false;
    }
  }
  return open;
}

const ROUNDS = Number(process.env['FS_GLOB_COMPARE_ROUNDS'] ?? '8');
const SEED = Number(process.env['FS_GLOB_COMPARE_SEED'] ?? '20261125');
const PATTERNS_PER_TREE = 60;

// A fixed tree and fixed patterns that show the rules Node follows, each compared with Node.
const SAMPLE_TREE: Tree = {
  files: [
    'a/b/f', 'a/f', 'a/.d', 'a/b/.e', '.h/c/g', '.h/g', 'x{y}/k', '${a,b}', 'a,b', '#c', '!n', 'ab', 'ac',
    'aé', 'a😀', 'b1/z', 'b2/z', 'A/q', 'real/x', 'real/sub/y', 'real/.h',
  ],
  links: [
    { path: 'link', target: 'real' },
    { path: 'flink', target: 'real/x' },
  ],
};

const SAMPLE_PATTERNS = [
  'a\\f', 'a/*', '**/f', '**/.d', '**/g', '.h/**', '*/.*', 'a?', 'a??', '?b', '{a,b1}/z', '{a,b1}/*', 'x{y}/k',
  '${a,b}', '{,a}', 'a//f', 'a/./f', './a/f', 'a/b/../f', 'a/*/../f', '*/../a/f', 'a/', 'a/**/', '#c', '!n',
  'a,b', 'a/b/**', 'A/q', 'a/Q', '*/q', 'link/x', '*/x', 'l*/x', '**/x', '**', 'link/**', 'link', '*', './**/x',
  'link/*', '*/*', 'link/', '*/sub/y', '**/.h', '**/.*', '**/.*/**', '*/**', '**/*', '[a]b', '[!a]*', 'b[12]/z',
];

describe('a fixed sample against Node fs.glob', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-fs-glob-sample-'));
    await buildTree(root, SAMPLE_TREE);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gives Node answer for every sample pattern, wider only through a link', async () => {
    const adapter = makeFsGlob({ cwd: root, platform: 'linux' });
    for (const pattern of SAMPLE_PATTERNS) {
      const expected = await nodeAnswer(root, pattern);
      const actual = await adapter.glob([pattern]);
      const extra = actual.filter((path) => !expected.includes(path));
      expect(actual.filter((path) => expected.includes(path)), pattern).toEqual(expected);
      for (const path of extra) expect(await widerCase(root, SAMPLE_TREE, pattern, path), `${pattern} -> ${path}`).not.toBeNull();
    }
  });
});

describe('the adapter against Node fs.glob', { timeout: 600_000 }, () => {
  let parent = '';

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'usabl-fs-glob-compare-'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('lists every file Node lists, and more only in the named cases', async () => {
    const next = random(SEED);
    const missing: string[] = [];
    const wider: Record<string, number> = {};
    const unexplained: string[] = [];
    let compared = 0;
    let matched = 0;
    let ignoringCaseWider = 0;
    // Patterns past the bound, which the adapter does not run.
    const skipped: string[] = [];
    const widerExamples: string[] = [];
    let skippedWithFiles = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = join(parent, `tree-${String(round)}`);
      const tree = makeTree(next);
      await buildTree(root, tree);
      const adapter = makeFsGlob({ cwd: root, platform: 'linux' });
      const ignoringCase = makeFsGlob({ cwd: root, platform: 'darwin' });
      for (let i = 0; i < PATTERNS_PER_TREE; i += 1) {
        const pattern = makePattern(next, tree);
        const expected = await nodeAnswer(root, pattern);
        const actual = await adapter.glob([pattern]);
        compared += 1;
        if (expected.length > 0) matched += 1;
        // A platform that ignores case lists at least what Linux lists.
        const folded = new Set(await ignoringCase.glob([pattern]));
        for (const path of actual) if (!folded.has(path)) missing.push(`ignoring case: ${pattern} -> ${path}`);
        ignoringCaseWider += folded.size - actual.length;
        const got = new Set(actual);
        const notRun = fsGlobBoundProblem(pattern) !== null;
        if (notRun) skipped.push(pattern);
        if (notRun && expected.length > 0) skippedWithFiles += 1;
        for (const path of expected) if (!got.has(path) && !notRun) missing.push(`${pattern} -> ${path}`);
        const want = new Set(expected);
        for (const path of actual) {
          if (want.has(path)) continue;
          const reason = await widerCase(root, tree, pattern, path);
          if (reason === null) unexplained.push(`${pattern} -> ${path}`);
          else {
            wider[reason] = (wider[reason] ?? 0) + 1;
            widerExamples.push(`${reason}: ${pattern} -> ${path}`);
          }
        }
      }
    }
    if (process.env['FS_GLOB_COMPARE_REPORT'] === '1') {
      console.log(JSON.stringify({ compared, matched, ignoringCaseWider, skipped: skipped.length, skippedWithFiles, wider, widerExamples, skippedExamples: skipped.slice(0, 10), missing: missing.slice(0, 40), unexplained: unexplained.slice(0, 40) }, null, 2));
    }
    expect(missing).toEqual([]);
    expect(unexplained).toEqual([]);
    // Enough patterns match some file for the comparison to mean something.
    expect(matched).toBeGreaterThan(compared / 4);
    // Only patterns with syntax the filter does not read are past the bound.
    for (const pattern of skipped) expect(otherSyntax(pattern), pattern).toBe(true);
  });
});
