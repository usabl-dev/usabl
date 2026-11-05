/**
 * Dependency changes for coverage planning.
 *
 * A pull request that bumps the UI component library touches the app's package.json and the
 * lockfile and nothing else. Neither matches uiFileGlobs, so the planner read the change as nothing
 * to check while a new version of the library can change every screen. This module finds such
 * changes, and the planner treats each one as a wide-blast change: every screen is checked.
 *
 * A change counts when it is any change to a lockfile in the repository root or in one of the
 * app's folders, or a change to the dependency fields of one of the app's package.json files:
 * dependencies, devDependencies, peerDependencies, optionalDependencies, overrides, resolutions,
 * and pnpm.overrides. A package.json change that leaves every one of them as it was, such as one
 * that edits only scripts or metadata, does not count: the fields are compared, parsed, between
 * the tree and the trusted ref. It must never decide a verdict. When usabl cannot compare, because a version does not parse
 * or no trusted ref was given, the change counts, because counting it can only add checks.
 */
import { posix as path } from 'node:path';
import type { FsGlob, UsablConfig } from '../contracts/index.js';
import type { TrustedRead } from './workspace-packages.js';

const LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
// The package.json fields that decide which version of a package is installed. Counting a field
// that does not can only add checks, so the list leans wide.
const TOP_LEVEL_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions'] as const;

/** A changed file that can change every screen, and one sentence that says why it counts. */
export interface DependencyChange {
  file: string;
  why: string;
}

/** The sentence every dependency change ends with, after the sentence of each file. */
export const EVERY_SCREEN =
  'A dependency upgrade, such as a new version of the UI component library, can change every screen, so usabl checks every screen.';

function manifestPath(dir: string): string {
  return dir === '' ? 'package.json' : `${dir}/package.json`;
}

// The part of a glob before its first segment with glob syntax, such as packages/admin/src for
// packages/admin/src/**/*.tsx. Every match sits in that folder.
function staticPrefix(glob: string): string {
  const segments: string[] = [];
  for (const segment of glob.split('/')) {
    if (/[*?[\]{}!]/u.test(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

// The folders that hold one of the app's package.json files: for each place the config points into
// (the router file, the uiFileGlobs folders, and the surface files), every folder from it up to the
// repository root that has a package.json in the tree or at the trusted ref. Not only the nearest
// one: a pull request can add a package.json below the real manifest, and the nearest one would
// then move the app folder off it, so a bump of the real manifest would not count. A repository
// with one package at its root has the root as its app folder.
async function appDirs(fs: FsGlob, config: UsablConfig, trusted: TrustedRead | undefined): Promise<Set<string>> {
  const anchors = [
    path.dirname(config.discovery.routerFile.replace(/^\/+/u, '')),
    ...config.uiFileGlobs.map((glob) => staticPrefix(glob.replace(/^\/+/u, ''))),
    ...config.surfaces.flatMap((surface) => surface.files.map((file) => path.dirname(file.replace(/^\/+/u, '')))),
  ];
  const found = new Set<string>();
  const known = new Map<string, boolean>();
  const hasManifest = async (dir: string): Promise<boolean> => {
    const cached = known.get(dir);
    if (cached !== undefined) return cached;
    const file = manifestPath(dir);
    const present = (await fs.readFile(file)) !== null || (trusted !== undefined && (await trusted(file)) !== null);
    known.set(dir, present);
    return present;
  };
  for (const anchor of anchors) {
    const normalized = path.normalize(anchor === '' ? '.' : anchor);
    // A path that leaves the repository names no folder of it.
    if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) continue;
    let dir = normalized === '.' ? '' : normalized.replace(/\/+$/u, '');
    for (;;) {
      if (await hasManifest(dir)) found.add(dir);
      if (dir === '') break;
      const parent = path.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }
  return found;
}

// A JSON value written with its object keys sorted, so two values compare equal exactly when they
// hold the same data, whatever the key order and the whitespace of the file.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The dependency fields of a parsed package.json, compared as one string. An absent field reads as
// null, so a manifest with none of them gives the same string as an empty object.
function fieldsOf(record: Record<string, unknown>): string {
  const pnpm = record['pnpm'];
  return canonical({
    ...Object.fromEntries(TOP_LEVEL_FIELDS.map((field) => [field, record[field] ?? null])),
    'pnpm.overrides': isRecord(pnpm) ? (pnpm['overrides'] ?? null) : null,
  });
}

// The dependency fields of a package.json file. A missing file declares none, the same as an empty
// object. Null when the file exists and is not a JSON object.
function dependencyFields(raw: string | null): string | null {
  if (raw === null) return fieldsOf({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(parsed) ? fieldsOf(parsed) : null;
}

/**
 * Each changed file that is a dependency change of the configured app, sorted by path.
 * The files given are the ones the planner did not already count as UI. trusted reads the trusted
 * ref, which is what a package.json in the tree is compared against.
 */
export async function dependencyChanges(
  fs: FsGlob,
  config: UsablConfig,
  files: readonly string[],
  trusted?: TrustedRead,
): Promise<DependencyChange[]> {
  const candidates = [...new Set(files)].sort();
  if (candidates.length === 0) return [];
  const dirs = await appDirs(fs, config, trusted);
  const lockfiles = new Set<string>();
  for (const dir of ['', ...dirs]) {
    for (const name of LOCKFILES) lockfiles.add(dir === '' ? name : `${dir}/${name}`);
  }
  const manifests = new Set([...dirs].map(manifestPath));

  const changes: DependencyChange[] = [];
  for (const file of candidates) {
    if (lockfiles.has(file)) {
      changes.push({ file, why: `${file} is a lockfile, and a change to it can change the version of any installed package.` });
      continue;
    }
    if (!manifests.has(file)) continue;
    if (trusted === undefined) {
      changes.push({
        file,
        why: `${file} is the app's package.json, and usabl had no trusted version to compare it with, so it counts the change as a dependency change.`,
      });
      continue;
    }
    const tree = dependencyFields(await fs.readFile(file));
    const base = dependencyFields(await trusted(file));
    if (tree === null || base === null) {
      changes.push({
        file,
        why: `${file} is the app's package.json, and usabl could not read it as JSON${tree === null ? '' : ' at the trusted ref'}, so it counts the change as a dependency change.`,
      });
      continue;
    }
    if (tree !== base) {
      changes.push({ file, why: `${file} changed the dependency fields of the app's package.json.` });
    }
  }
  return changes;
}
