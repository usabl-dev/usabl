/**
 * Import graph discovery for coverage planning.
 * It follows only files that can be proven to exist on disk.
 * It must never guess alias config or unresolved file extensions.
 */
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

interface ImportGraphView {
  get(file: string): string[];
  unresolvable: string[];
}

// This pattern stays single-line by design. A multiline static import can be missed,
// which under-reports edges. Under-reporting is safer here because discovery must
// never invent import edges that were not proven by concrete source text and files.
const FROM_IMPORT_RE = /\bimport\s+(?:type\s+)?[^"'`;\n]+?\sfrom\s*["'`]([^"'`]+)["'`]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const PROBE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'];

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

function isAliasSpecifier(specifier: string): boolean {
  return specifier.startsWith('@/') || specifier.startsWith('~/');
}

function hasKnownExtension(specifier: string): boolean {
  return /\.[^/]+$/.test(specifier);
}

function resolveBaseFile(importer: string, specifier: string): string {
  return path.normalize(path.join(path.dirname(importer), specifier));
}

async function resolveRelativeImport(fs: FsGlob, importer: string, specifier: string): Promise<string | null> {
  const base = resolveBaseFile(importer, specifier);
  const candidates = hasKnownExtension(specifier) ? [base] : PROBE_EXTENSIONS.map((suffix) => `${base}${suffix}`);
  for (const candidate of candidates) {
    if ((await fs.readFile(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export async function buildImportGraph(fs: FsGlob, entryFiles: string[]): Promise<ImportGraphView> {
  const edges = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue = [...entryFiles];
  const unresolvable: string[] = [];

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
      if (isAliasSpecifier(specifier)) {
        pushUnique(unresolvable, `${file}:${specifier}`);
        continue;
      }

      if (!isRelativeSpecifier(specifier)) {
        continue;
      }

      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null) {
        pushUnique(unresolvable, `${file}:${specifier}`);
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
  };
}
