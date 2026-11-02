/**
 * Workspace package changes for coverage planning, in a monorepo.
 *
 * A config drafted for one app folder, such as packages/admin, has uiFileGlobs inside that folder.
 * A change in another workspace package the app imports, such as a shared component library,
 * matches none of them, so the planner would read it as nothing to check while the app renders the
 * changed component. This module finds those changes and returns a coverage gap for each one.
 *
 * It does not map such a change to screens. The import graph follows relative and alias imports
 * only, and a bare package import resolves through the package's own manifest: its exports
 * conditions, main or module fields, and often built output that is not in the repository. usabl
 * cannot read that soundly from source text, and a wrong guess would scan fewer screens than render
 * the change while the run reads as covered. A gap names the package and the fix instead.
 *
 * It must never decide a verdict. A package it cannot read is counted as one the app depends on,
 * because counting it can only turn nothing to check into a gap.
 */
import { posix as path } from 'node:path';
import yaml from 'js-yaml';
import type { CoverageGap, FsGlob, UsablConfig } from '../contracts/index.js';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

interface PackageManifest {
  // The folder, relative to the repository root, with no trailing slash. The root is ''.
  dir: string;
  // Null when package.json could not be read or names no package.
  name: string | null;
  // The names this package depends on, or null when its package.json could not be read.
  dependencies: Set<string> | null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// The workspace patterns of the repository: package.json "workspaces", as a list (npm, Yarn, Bun)
// or as { packages: [...] } (Yarn), and the packages list of pnpm-workspace.yaml.
async function workspacePatterns(fs: FsGlob, root: Record<string, unknown> | null): Promise<string[]> {
  const patterns: string[] = [];
  const workspaces = root?.['workspaces'];
  if (Array.isArray(workspaces)) {
    patterns.push(...stringList(workspaces));
  } else if (typeof workspaces === 'object' && workspaces !== null) {
    patterns.push(...stringList((workspaces as Record<string, unknown>)['packages']));
  }
  const pnpm = await fs.readFile('pnpm-workspace.yaml');
  if (pnpm !== null) {
    try {
      const parsed: unknown = yaml.load(pnpm, { schema: yaml.FAILSAFE_SCHEMA });
      if (typeof parsed === 'object' && parsed !== null) {
        patterns.push(...stringList((parsed as Record<string, unknown>)['packages']));
      }
    } catch {
      // A pnpm-workspace.yaml that does not parse lists no packages. pnpm itself refuses it.
    }
  }
  return patterns;
}

function cleanPattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function isInstalledPath(file: string): boolean {
  return file.split('/').includes('node_modules');
}

// The folders the workspace patterns name, each one that holds a package.json. A pattern that
// starts with ! removes the folders it names, as npm, Yarn, and pnpm read it.
async function workspaceDirs(fs: FsGlob, patterns: string[]): Promise<string[]> {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.trim().startsWith('!');
    const pattern = cleanPattern(negated ? raw.trim().slice(1) : raw);
    if (pattern === '' || pattern.startsWith('/') || pattern.split('/').includes('..')) continue;
    for (const manifest of await fs.glob([`${pattern}/package.json`])) {
      if (isInstalledPath(manifest)) continue;
      (negated ? excluded : included).add(path.dirname(manifest));
    }
  }
  return [...included].filter((dir) => !excluded.has(dir) && dir !== '.' && dir !== '').sort();
}

async function readManifest(fs: FsGlob, dir: string): Promise<PackageManifest> {
  const parsed = parseJsonObject(await fs.readFile(dir === '' ? 'package.json' : `${dir}/package.json`));
  if (parsed === null) return { dir, name: null, dependencies: null };
  const name = typeof parsed['name'] === 'string' && parsed['name'] !== '' ? parsed['name'] : null;
  const dependencies = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = parsed[field];
    if (typeof deps === 'object' && deps !== null && !Array.isArray(deps)) {
      for (const dependency of Object.keys(deps)) dependencies.add(dependency);
    }
  }
  return { dir, name, dependencies };
}

function isInside(file: string, dir: string): boolean {
  return dir === '' || file.startsWith(`${dir}/`);
}

// The deepest package folder a path sits in. Packages can nest, and a file belongs to the nearest.
function ownerOf(file: string, packages: readonly PackageManifest[]): PackageManifest | null {
  let owner: PackageManifest | null = null;
  for (const candidate of packages) {
    if (isInside(file, candidate.dir) && (owner === null || candidate.dir.length > owner.dir.length)) {
      owner = candidate;
    }
  }
  return owner;
}

// The part of a glob before its first segment with glob syntax, such as packages/admin/src for
// packages/admin/src/**/*.tsx. It names a folder every match sits in.
function staticPrefix(glob: string): string {
  const segments: string[] = [];
  for (const segment of glob.split('/')) {
    if (/[*?[\]{}!]/u.test(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

// The packages the config points into: the one the router file sits in, the ones the uiFileGlobs
// folders sit in, and the ones that hold a surface's files. Those are the app being checked.
function appPackages(config: UsablConfig, packages: readonly PackageManifest[]): PackageManifest[] {
  const anchors = [
    config.discovery.routerFile,
    ...config.uiFileGlobs.map((glob) => `${staticPrefix(glob)}/`),
    ...config.surfaces.flatMap((surface) => surface.files),
  ];
  const found = new Map<string, PackageManifest>();
  for (const anchor of anchors) {
    const owner = ownerOf(anchor.replace(/^\/+/u, ''), packages);
    if (owner !== null) found.set(owner.dir, owner);
  }
  return [...found.values()];
}

// Every workspace package the app packages depend on, directly or through another workspace
// package. A package whose manifest could not be read may depend on any of them, so all count.
function dependencyClosure(apps: readonly PackageManifest[], workspace: readonly PackageManifest[]): Map<string, PackageManifest> {
  const reached = new Map<string, PackageManifest>();
  const queue = [...apps];
  const visited = new Set<string>();
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);
    for (const candidate of workspace) {
      if (candidate.dir === current.dir) continue;
      const depends =
        current.dependencies === null || (candidate.name !== null && current.dependencies.has(candidate.name)) || candidate.name === null;
      if (!depends) continue;
      if (!reached.has(candidate.dir)) reached.set(candidate.dir, candidate);
      queue.push(candidate);
    }
  }
  return reached;
}

// Markdown files are documentation, not code an app renders.
function isDocumentation(file: string): boolean {
  return /\.md$/iu.test(file);
}

function gapFor(file: string, pkg: PackageManifest, apps: readonly PackageManifest[]): CoverageGap {
  const appNames = apps
    .map((app) => (app.dir === '' ? 'the app at the repository root' : app.dir))
    .sort()
    .join(', ');
  const label = pkg.name === null ? `the workspace package in ${pkg.dir}` : `the workspace package ${pkg.name} in ${pkg.dir}`;
  const read =
    pkg.name === null ? ` Its package.json could not be read, so usabl counts it as one ${appNames} depends on.` : '';
  return {
    ref: file,
    state: 'not-covered',
    reason:
      `This file is in ${label}, which ${appNames} depends on, and it is not in uiFileGlobs.${read} ` +
      'The app may render it, but usabl cannot tell which screens do, so it did not check this change. ' +
      `To check it, add the package's source to uiFileGlobs, such as ${pkg.dir}/src/**/*.tsx, and list the ` +
      "file in the files of each surface that renders it.",
  };
}

/**
 * A not-covered gap for each changed file that sits in a workspace package the configured app
 * depends on, directly or through another workspace package. The files given are the ones the
 * planner did not already count as UI: not tests, and outside uiFileGlobs. A repository with no
 * workspaces, a file outside every workspace package, a file in a package the app does not depend
 * on, and a file in the app's own package give no gap.
 */
export async function workspaceDependencyGaps(fs: FsGlob, config: UsablConfig, files: readonly string[]): Promise<CoverageGap[]> {
  const candidates = files.filter((file) => !isInstalledPath(file) && !isDocumentation(file));
  if (candidates.length === 0) return [];
  const rootManifest = parseJsonObject(await fs.readFile('package.json'));
  const dirs = await workspaceDirs(fs, await workspacePatterns(fs, rootManifest));
  if (dirs.length === 0) return [];

  const workspace: PackageManifest[] = [];
  for (const dir of dirs) workspace.push(await readManifest(fs, dir));
  const root = await readManifest(fs, '');
  const all = [root, ...workspace];
  const apps = appPackages(config, all);
  if (apps.length === 0) return [];
  const appDirs = new Set(apps.map((app) => app.dir));
  const reached = dependencyClosure(apps, workspace);

  const gaps: CoverageGap[] = [];
  for (const file of [...new Set(candidates)].sort()) {
    const owner = ownerOf(file, workspace);
    if (owner === null || appDirs.has(owner.dir) || !reached.has(owner.dir)) continue;
    gaps.push(gapFor(file, owner, apps));
  }
  return gaps;
}
