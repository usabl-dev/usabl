/**
 * Import graph discovery for coverage planning.
 * It follows only files that can be proven to exist on disk.
 * It must never guess alias config or pick between candidate files.
 * `unresolvable` records incomplete graph evidence, not a coverage gap by itself.
 */
// Use POSIX paths so coverage keys stay stable across operating systems.
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';
import {
  type AliasConfig,
  isAliasLikeSpecifier,
  resolveAliasSpecifierEachWay,
} from './alias-config.js';

const NO_ALIASES: AliasConfig = { mappings: [], hasAliasConfig: false };

export type UnresolvableImport =
  | {
      importer: string;
      specifier: string;
      kind: 'alias-unconfigured' | 'alias-unmapped' | 'file-not-found';
    }
  | {
      importer: string;
      specifier: string;
      // More than one file could be what the import loads. usabl does not pick one.
      kind: 'ambiguous-candidates';
      // Every candidate that exists, sorted.
      candidates: string[];
    }
  | {
      importer: string;
      specifier: string;
      // The alias configs usabl reads map the import to more than one place, and usabl cannot
      // tell which one the build uses. Every file found is linked.
      kind: 'alias-conflict';
      // Each path the import resolves to, sorted.
      targets: string[];
      // Every file found at those paths, sorted.
      candidates: string[];
    };

export interface ImportGraphView {
  get(file: string): string[];
  unresolvable: UnresolvableImport[];
  visited: ReadonlySet<string>;
}

// This pattern stays single-line by design. A multiline static import can be missed,
// which under-reports edges. Under-reporting is safer here because discovery must
// never invent import edges that were not proven by concrete source text and files.
const FROM_IMPORT_RE = /\bimport\s+(?:type\s+)?[^"'`;\n]+?\sfrom\s*["'`]([^"'`]+)["'`]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
// Candidate suffixes for an extensionless import, split into a file tier and a directory-index
// tier. The list is fixed: Vite's default JS and TS extensions, plus .vue and .svelte, which a
// project can add to resolve.extensions. usabl does not read resolve.extensions from the Vite
// config, because it cannot run the config, and a partial read that missed an extension would be
// worse than a list that may hold too many. The bundler's exact pick depends on that order, so
// when more than one candidate exists in a tier we link all of them and disclose the ambiguity
// instead of guessing. Guessing, or linking none, could leave a screen that renders the changed
// file out of the scan.
const EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
const FILE_SUFFIXES = EXTENSIONS;
const INDEX_SUFFIXES = EXTENSIONS.map((extension) => `/index${extension}`);

function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(FROM_IMPORT_RE)) {
    const [, specifier] = match;
    if (typeof specifier === 'string') {
      found.push(specifier);
    }
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const [, specifier] = match;
    if (typeof specifier === 'string') {
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Whether source text names a package, or a subpath of it, as a quoted module specifier: in an
 * import or export from, a dynamic import, a require, or a bare import for its side effects, on one
 * line or across several. It matches the quoted name anywhere, so a string that only looks like an
 * import also counts. That can only over-count, which is the safe direction for a caller asking
 * whether a package is used. The single-line patterns above would miss a multi-line import.
 */
export function mentionsPackage(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(["'\`])${escaped}(?:/[^"'\`]*)?\\1`).test(source);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

function hasKnownExtension(specifier: string): boolean {
  return /\.[^/]+$/.test(specifier);
}

function resolveBaseFile(importer: string, specifier: string): string {
  return path.normalize(path.join(path.dirname(importer), specifier));
}

async function existingCandidates(fs: FsGlob, base: string, suffixes: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const suffix of suffixes) {
    if ((await fs.readFile(`${base}${suffix}`)) !== null) {
      hits.push(`${base}${suffix}`);
    }
  }
  return hits;
}

// What an import path resolves to: one file, several candidates usabl will not choose between,
// or nothing on disk.
type Resolution = { file: string } | { candidates: string[] } | null;

// TypeScript ESM code imports a .ts file under the name it is built to: ./Child.js loads Child.ts
// or Child.tsx. The compiler and the bundler both map these, and only when no file has the
// written name. A .d.ts file holds types only and renders nothing, so it is not a candidate.
const TYPESCRIPT_NAMES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

async function resolveTypeScriptName(fs: FsGlob, filePath: string): Promise<Resolution> {
  const extension = path.extname(filePath);
  const replacements = TYPESCRIPT_NAMES[extension];
  if (replacements === undefined) return null;
  const hits = await existingCandidates(fs, filePath.slice(0, -extension.length), replacements);
  if (hits.length === 1 && hits[0] !== undefined) return { file: hits[0] };
  return hits.length > 1 ? { candidates: [...hits].sort() } : null;
}

async function resolveFileAtPath(fs: FsGlob, filePath: string): Promise<Resolution> {
  if (hasKnownExtension(filePath)) {
    if ((await fs.readFile(filePath)) !== null) return { file: filePath };
    return resolveTypeScriptName(fs, filePath);
  }
  // File tier before index tier (the bundler prefers a file over a directory index). Within a tier,
  // exactly one hit resolves; more than one is ambiguous, so disclose rather than pick.
  for (const suffixes of [FILE_SUFFIXES, INDEX_SUFFIXES]) {
    const hits = await existingCandidates(fs, filePath, suffixes);
    if (hits.length === 1 && hits[0] !== undefined) {
      return { file: hits[0] };
    }
    if (hits.length > 1) {
      return { candidates: [...hits].sort() };
    }
  }
  return null;
}

async function resolveRelativeImport(fs: FsGlob, importer: string, specifier: string): Promise<Resolution> {
  const base = resolveBaseFile(importer, specifier);
  return resolveFileAtPath(fs, base);
}

// The files an import links to. An ambiguous import links every candidate: a change to any of them
// then maps to the screen, which can scan a screen that does not render the changed file, but
// never leaves out one that does. The ambiguity is still disclosed.
function edgeTargets(resolution: Resolution): string[] {
  if (resolution === null) return [];
  return 'file' in resolution ? [resolution.file] : resolution.candidates;
}

// The disclosure for an import that did not resolve to exactly one file.
function unresolvedEntry(
  importer: string,
  specifier: string,
  resolution: { candidates: string[] } | null,
): UnresolvableImport {
  return resolution === null
    ? { importer, specifier, kind: 'file-not-found' }
    : { importer, specifier, kind: 'ambiguous-candidates', candidates: resolution.candidates };
}

// The files an alias import links to, and its disclosure when it did not resolve to exactly one
// file. An import the configs map to more than one place resolves at each, and links every file
// found there: dropping any of them could leave out a screen that renders the changed file.
async function resolveAliasImport(
  fs: FsGlob,
  importer: string,
  specifier: string,
  aliasConfig: AliasConfig,
): Promise<{ targets: string[]; disclosure: UnresolvableImport | null }> {
  const aliasPaths = resolveAliasSpecifierEachWay(specifier, aliasConfig);
  if (aliasPaths.length === 0) {
    const kind = aliasConfig.hasAliasConfig ? 'alias-unmapped' : 'alias-unconfigured';
    return { targets: [], disclosure: { importer, specifier, kind } };
  }
  if (aliasPaths.length === 1 && aliasPaths[0] !== undefined) {
    const resolved = await resolveFileAtPath(fs, aliasPaths[0]);
    const disclosure = resolved === null || 'candidates' in resolved ? unresolvedEntry(importer, specifier, resolved) : null;
    return { targets: edgeTargets(resolved), disclosure };
  }
  const found = new Set<string>();
  for (const aliasPath of aliasPaths) {
    for (const target of edgeTargets(await resolveFileAtPath(fs, aliasPath))) found.add(target);
  }
  const candidates = [...found].sort();
  if (candidates.length === 0) {
    return { targets: [], disclosure: { importer, specifier, kind: 'file-not-found' } };
  }
  return { targets: candidates, disclosure: { importer, specifier, kind: 'alias-conflict', targets: aliasPaths, candidates } };
}

function pushUniqueUnresolvable(list: UnresolvableImport[], entry: UnresolvableImport): void {
  const key = `${entry.importer}:${entry.specifier}:${entry.kind}`;
  if (!list.some((item) => `${item.importer}:${item.specifier}:${item.kind}` === key)) {
    list.push(entry);
  }
}

export async function buildImportGraph(
  fs: FsGlob,
  entryFiles: string[],
  aliasConfig?: AliasConfig,
): Promise<ImportGraphView> {
  const edges = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue = [...entryFiles];
  const unresolvable: UnresolvableImport[] = [];
  const aliases = aliasConfig ?? NO_ALIASES;

  while (queue.length > 0) {
    const file = queue.shift();
    if (typeof file !== 'string' || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = await fs.readFile(file);
    if (source === null) {
      continue;
    }

    const fileEdges = edges.get(file) ?? [];
    for (const specifier of extractSpecifiers(source)) {
      if (isAliasLikeSpecifier(specifier)) {
        const { targets, disclosure } = await resolveAliasImport(fs, file, specifier, aliases);
        if (disclosure !== null) pushUniqueUnresolvable(unresolvable, disclosure);
        for (const target of targets) {
          pushUnique(fileEdges, target);
          queue.push(target);
        }
        continue;
      }

      if (!isRelativeSpecifier(specifier)) {
        // Bare package imports are not app-surface files, so they are ignored.
        continue;
      }

      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null || 'candidates' in resolved) {
        pushUniqueUnresolvable(unresolvable, unresolvedEntry(file, specifier, resolved));
      }
      for (const target of edgeTargets(resolved)) {
        pushUnique(fileEdges, target);
        queue.push(target);
      }
    }
    edges.set(file, fileEdges);
  }

  return {
    get(file: string): string[] {
      return edges.get(file) ?? [];
    },
    unresolvable,
    visited,
  };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export async function inspectDirectImports(
  fs: FsGlob,
  file: string,
  aliasConfig?: AliasConfig,
): Promise<UnresolvableImport[]> {
  const source = await fs.readFile(file);
  if (source === null) {
    return [];
  }
  const aliases = aliasConfig ?? NO_ALIASES;
  const unresolvable: UnresolvableImport[] = [];

  for (const specifier of extractSpecifiers(source)) {
    if (isAliasLikeSpecifier(specifier)) {
      const { disclosure } = await resolveAliasImport(fs, file, specifier, aliases);
      if (disclosure !== null) pushUniqueUnresolvable(unresolvable, disclosure);
      continue;
    }
    if (isRelativeSpecifier(specifier)) {
      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null || 'candidates' in resolved) {
        pushUniqueUnresolvable(unresolvable, unresolvedEntry(file, specifier, resolved));
      }
    }
  }
  return unresolvable;
}
