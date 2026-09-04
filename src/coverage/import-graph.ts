/**
 * Import graph discovery for coverage planning.
 * It follows only files that can be proven to exist on disk.
 * It must never guess alias config or unresolved file extensions.
 * `unresolvable` records incomplete graph evidence, not a coverage gap by itself.
 */
// Use POSIX paths so coverage keys stay stable across operating systems.
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';
import {
  type AliasConfig,
  isAliasLikeSpecifier,
  resolveAliasSpecifier,
} from './alias-config.js';

export interface UnresolvableImport {
  importer: string;
  specifier: string;
  kind: 'alias-unconfigured' | 'alias-unmapped' | 'file-not-found';
}

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
// tier. The bundler's exact pick depends on its resolve.extensions order, which we do not parse, so
// when more than one candidate exists in a tier we disclose instead of guessing. Guessing could
// attribute a changed file to a screen that actually renders the sibling file.
const FILE_SUFFIXES = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx'];
const INDEX_SUFFIXES = ['/index.mjs', '/index.js', '/index.mts', '/index.ts', '/index.jsx', '/index.tsx'];

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

async function resolveFileAtPath(fs: FsGlob, filePath: string): Promise<string | null> {
  if (hasKnownExtension(filePath)) {
    return (await fs.readFile(filePath)) !== null ? filePath : null;
  }
  // File tier before index tier (the bundler prefers a file over a directory index). Within a tier,
  // exactly one hit resolves; more than one is ambiguous, so disclose rather than pick.
  const fileHits = await existingCandidates(fs, filePath, FILE_SUFFIXES);
  if (fileHits.length === 1) {
    return fileHits[0] ?? null;
  }
  if (fileHits.length > 1) {
    return null;
  }
  const indexHits = await existingCandidates(fs, filePath, INDEX_SUFFIXES);
  return indexHits.length === 1 ? (indexHits[0] ?? null) : null;
}

async function resolveRelativeImport(fs: FsGlob, importer: string, specifier: string): Promise<string | null> {
  const base = resolveBaseFile(importer, specifier);
  return resolveFileAtPath(fs, base);
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
  const mappings = aliasConfig?.mappings ?? [];
  const hasAliasConfig = aliasConfig?.hasAliasConfig ?? false;

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
        const aliasPath = resolveAliasSpecifier(specifier, mappings);
        if (aliasPath === null) {
          pushUniqueUnresolvable(unresolvable, {
            importer: file,
            specifier,
            kind: hasAliasConfig ? 'alias-unmapped' : 'alias-unconfigured',
          });
          continue;
        }
        const resolved = await resolveFileAtPath(fs, aliasPath);
        if (resolved === null) {
          pushUniqueUnresolvable(unresolvable, {
            importer: file,
            specifier,
            kind: 'file-not-found',
          });
          continue;
        }
        pushUnique(fileEdges, resolved);
        queue.push(resolved);
        continue;
      }

      if (!isRelativeSpecifier(specifier)) {
        // Bare package imports are not app-surface files, so they are ignored.
        continue;
      }

      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null) {
        pushUniqueUnresolvable(unresolvable, {
          importer: file,
          specifier,
          kind: 'file-not-found',
        });
        continue;
      }

      pushUnique(fileEdges, resolved);
      queue.push(resolved);
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
  const mappings = aliasConfig?.mappings ?? [];
  const hasAliasConfig = aliasConfig?.hasAliasConfig ?? false;
  const unresolvable: UnresolvableImport[] = [];

  for (const specifier of extractSpecifiers(source)) {
    if (isAliasLikeSpecifier(specifier)) {
      const aliasPath = resolveAliasSpecifier(specifier, mappings);
      if (aliasPath === null) {
        pushUniqueUnresolvable(unresolvable, {
          importer: file,
          specifier,
          kind: hasAliasConfig ? 'alias-unmapped' : 'alias-unconfigured',
        });
        continue;
      }
      const resolved = await resolveFileAtPath(fs, aliasPath);
      if (resolved === null) {
        pushUniqueUnresolvable(unresolvable, {
          importer: file,
          specifier,
          kind: 'file-not-found',
        });
      }
      continue;
    }
    if (isRelativeSpecifier(specifier)) {
      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null) {
        pushUniqueUnresolvable(unresolvable, {
          importer: file,
          specifier,
          kind: 'file-not-found',
        });
      }
    }
  }
  return unresolvable;
}
