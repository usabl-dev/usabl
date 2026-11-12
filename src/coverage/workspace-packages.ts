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
import { loadAliasConfig } from './alias-config.js';
import { mentionsPackage } from './import-graph.js';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

interface PackageManifest {
  // The folder, relative to the repository root, with no trailing slash. The root is ''.
  dir: string;
  // Null when package.json could not be read or names no package.
  name: string | null;
  // The names this package depends on, or null when its package.json could not be read. A
  // dependency declared under another name, such as "ui": "npm:@org/shared@1", adds the real name.
  dependencies: Set<string> | null;
  // The folders, relative to the repository root, that a file:, link:, portal:, or workspace: path
  // dependency points at.
  dependencyDirs: Set<string>;
}

// A root manifest or pnpm-workspace.yaml that exists and cannot be read. The workspace packages
// are then unknown, so any changed file may sit in one the app depends on.
class UnreadableWorkspaceRoot extends Error {
  constructor(readonly file: string, readonly problem: string) {
    super(`${file} ${problem}`);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A list of patterns, or the reason it is not one. Absent is an empty list.
function patternList(value: unknown): string[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

// The workspace patterns of the repository: package.json "workspaces", as a list (npm, Yarn, Bun)
// or as { packages: [...] } (Yarn), and the packages list of pnpm-workspace.yaml. Throws
// UnreadableWorkspaceRoot when either file exists and cannot be read, or holds the field in a shape
// no package manager reads. A missing file lists no packages.
async function workspacePatterns(read: (file: string) => Promise<string | null>): Promise<string[]> {
  const patterns: string[] = [];
  const rawRoot = await read('package.json');
  if (rawRoot !== null) {
    const root = parseJsonObject(rawRoot);
    if (root === null) throw new UnreadableWorkspaceRoot('package.json', 'is not a JSON object');
    const workspaces = root['workspaces'];
    const listed = isRecord(workspaces) ? patternList(workspaces['packages']) : patternList(workspaces);
    if (listed === null) throw new UnreadableWorkspaceRoot('package.json', 'has a "workspaces" field that is not a list of patterns');
    patterns.push(...listed);
  }
  const pnpm = await read('pnpm-workspace.yaml');
  if (pnpm !== null) {
    let parsed: unknown;
    try {
      parsed = yaml.load(pnpm, { schema: yaml.FAILSAFE_SCHEMA });
    } catch {
      throw new UnreadableWorkspaceRoot('pnpm-workspace.yaml', 'is not valid YAML');
    }
    // An empty file lists no packages.
    if (parsed !== undefined && parsed !== null) {
      const listed = isRecord(parsed) ? patternList(parsed['packages']) : null;
      if (listed === null) throw new UnreadableWorkspaceRoot('pnpm-workspace.yaml', 'does not hold a "packages" list of patterns');
      patterns.push(...listed);
    }
  }
  return patterns;
}

// A path inside the repository, normalized, or null for one that is absolute or leaves it.
function insideRepository(file: string): string | null {
  if (path.isAbsolute(file)) return null;
  const normalized = path.normalize(file);
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
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
    // A brace group can hold .. or an absolute path, such as {..,packages/*}, and the glob expands
    // it, so a pattern with .. anywhere in a brace group is refused before it is globbed.
    if (pattern === '' || pattern.startsWith('/') || pattern.split('/').includes('..')) continue;
    if (/[{}]/u.test(pattern) && pattern.includes('..')) continue;
    for (const found of await fs.glob([`${pattern}/package.json`])) {
      // Whatever the pattern, a result outside the repository is never read.
      const manifest = insideRepository(found);
      if (manifest === null || isInstalledPath(manifest)) continue;
      (negated ? excluded : included).add(path.dirname(manifest));
    }
  }
  return [...included].filter((dir) => !excluded.has(dir) && dir !== '.' && dir !== '').sort();
}

// What a dependency value points at besides its key: the real package name of an alias, such as
// workspace:@org/shared@* or npm:@org/shared@^1, or the folder of a path, such as file:../shared.
// A path is read from the declaring package's folder, and one that leaves the repository names no
// workspace package.
function dependencyTarget(value: unknown, fromDir: string): { name: string } | { dir: string } | null {
  if (typeof value !== 'string') return null;
  const spec = value.trim();
  const protocol = /^(workspace|npm|file|link|portal):(.*)$/u.exec(spec);
  if (protocol === null) return null;
  const [, kind, rest = ''] = protocol;
  const isPath = kind === 'file' || kind === 'link' || kind === 'portal' || rest.startsWith('.') || rest.startsWith('/');
  if (isPath) {
    if (rest.startsWith('/')) return null;
    const dir = insideRepository(path.join(fromDir === '' ? '.' : fromDir, rest).replace(/\/+$/u, ''));
    return dir === null ? null : { dir: dir === '.' ? '' : dir };
  }
  // A name, then an optional @range. A scoped name keeps its leading @.
  const named = /^(@[^/@\s]+\/[^@\s]+|[^@\s][^@\s]*)(?:@.*)?$/u.exec(rest);
  if (named === null || named[1] === undefined) return null;
  // workspace:* and workspace:^1.0.0 name no package: the key is the name.
  return /^[*^~<>=0-9]/u.test(named[1]) ? null : { name: named[1] };
}

async function readManifest(read: (file: string) => Promise<string | null>, dir: string): Promise<PackageManifest> {
  const parsed = parseJsonObject(await read(dir === '' ? 'package.json' : `${dir}/package.json`));
  const dependencyDirs = new Set<string>();
  if (parsed === null) return { dir, name: null, dependencies: null, dependencyDirs };
  const name = typeof parsed['name'] === 'string' && parsed['name'] !== '' ? parsed['name'] : null;
  const dependencies = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = parsed[field];
    if (isRecord(deps)) {
      for (const [dependency, value] of Object.entries(deps)) {
        dependencies.add(dependency);
        const target = dependencyTarget(value, dir);
        if (target === null) continue;
        if ('name' in target) dependencies.add(target.name);
        else dependencyDirs.add(target.dir);
      }
    }
  }
  return { dir, name, dependencies, dependencyDirs };
}

// The manifest as the tree has it, joined with the manifest at the trusted ref when one is given.
// A change can remove the dependency that links the app to a package in the same change that edits
// the package, so the dependencies of either version count. A package.json the trusted ref does not
// have adds nothing.
async function readManifestBoth(fs: FsGlob, trusted: TrustedRead | undefined, dir: string): Promise<PackageManifest> {
  const tree = await readManifest((file) => fs.readFile(file), dir);
  if (trusted === undefined) return tree;
  const file = dir === '' ? 'package.json' : `${dir}/package.json`;
  if ((await trusted(file)) === null) return tree;
  const base = await readManifest(trusted, dir);
  const dependencies = tree.dependencies === null || base.dependencies === null ? null : new Set([...tree.dependencies, ...base.dependencies]);
  return {
    dir,
    name: tree.name ?? base.name,
    dependencies,
    dependencyDirs: new Set([...tree.dependencyDirs, ...base.dependencyDirs]),
  };
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

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'];

// What a package links to without declaring it: the names its source files import, and the
// folders its path aliases point into. With npm, Yarn classic, or Bun hoisting, a package can import
// another workspace package it does not list, and a tsconfig paths or Vite alias can point into one.
// Both run, so both count. A source file the glob found but that cannot be read may import any
// package, so it makes everything count.
interface Undeclared {
  sources: string[] | null;
  aliasTargets: string[];
}

async function undeclaredLinks(fs: FsGlob, pkg: PackageManifest, workspace: readonly PackageManifest[]): Promise<Undeclared> {
  const prefix = pkg.dir === '' ? '' : `${pkg.dir}/`;
  const found = await fs.glob(SOURCE_EXTENSIONS.map((extension) => `${prefix}**/*.${extension}`));
  const sources: string[] = [];
  for (const raw of found) {
    const file = insideRepository(raw);
    // A file in node_modules is installed code, and a file in a nested package is that package's.
    if (file === null || isInstalledPath(file) || ownerOf(file, workspace)?.dir !== pkg.dir) continue;
    const text = await fs.readFile(file);
    if (text === null) return { sources: null, aliasTargets: [] };
    sources.push(text);
  }
  // The package's own configs, read the way init reads an app's, and the repository root's.
  const scoped: FsGlob = { readFile: (file) => fs.readFile(`${prefix}${file}`), glob: (patterns) => fs.glob(patterns) };
  const aliasTargets = (await loadAliasConfig(scoped)).mappings.map(({ target }) => path.normalize(path.join(pkg.dir === '' ? '.' : pkg.dir, target)));
  if (pkg.dir !== '') aliasTargets.push(...(await loadAliasConfig(fs)).mappings.map(({ target }) => path.normalize(target)));
  return { sources, aliasTargets };
}

function dependsOn(current: PackageManifest, links: Undeclared, candidate: PackageManifest): boolean {
  if (current.dependencies === null || candidate.name === null || links.sources === null) return true;
  if (current.dependencies.has(candidate.name) || current.dependencyDirs.has(candidate.dir)) return true;
  if (links.aliasTargets.some((target) => isInside(target.replace(/\/+$/u, ''), candidate.dir) || target.replace(/\/+$/u, '') === candidate.dir)) {
    return true;
  }
  const name = candidate.name;
  return links.sources.some((source) => mentionsPackage(source, name));
}

// Every workspace package the app packages depend on, directly or through another workspace
// package. A package whose manifest could not be read may depend on any of them, so all count. The
// source scan runs only for a package that leaves a changed package unreached by declarations.
async function dependencyClosure(
  fs: FsGlob,
  apps: readonly PackageManifest[],
  workspace: readonly PackageManifest[],
  changedOwners: ReadonlySet<string>,
): Promise<Map<string, PackageManifest>> {
  const reached = new Map<string, PackageManifest>();
  const queue = [...apps];
  const visited = new Set<string>();
  const declaredOnly: Undeclared = { sources: [], aliasTargets: [] };
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);
    const others = workspace.filter((candidate) => candidate.dir !== current.dir);
    const needsScan = others.some((candidate) => changedOwners.has(candidate.dir) && !reached.has(candidate.dir) && !dependsOn(current, declaredOnly, candidate));
    const links = needsScan ? await undeclaredLinks(fs, current, workspace) : declaredOnly;
    for (const candidate of others) {
      if (!dependsOn(current, links, candidate)) continue;
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

function unreadableRootGap(file: string, unreadable: UnreadableWorkspaceRoot, refLabel: string): CoverageGap {
  return {
    ref: file,
    state: 'not-covered',
    reason:
      `usabl could not read the workspace packages of this repository: ${unreadable.file}${refLabel} ${unreadable.problem}. ` +
      'This file may sit in a workspace package the app renders, so usabl did not check this change. ' +
      `Fix ${unreadable.file}, then run usabl again.`,
  };
}

/**
 * The folders of the workspace packages the repository root lists, in package.json "workspaces"
 * and pnpm-workspace.yaml, sorted. Empty when the root lists none or cannot be read: a caller that
 * only adds notes reads that as nothing more to name.
 */
export async function workspacePackageDirs(fs: FsGlob): Promise<string[]> {
  try {
    return await workspaceDirs(fs, [...new Set(await workspacePatterns((file) => fs.readFile(file)))]);
  } catch (err) {
    if (err instanceof UnreadableWorkspaceRoot) return [];
    throw err;
  }
}

/**
 * The package names the app can import by a bare name, sorted: every name declared in the
 * dependency fields of a package.json on the climb from each place the config points into (the
 * router file, the folder of each uiFileGlobs pattern, and each surface file) to the repository
 * root, and the name and dependencies of every workspace package the root lists. A package.json
 * that is missing or cannot be read adds none, so an import of a package it would declare is not
 * explained by it.
 */
export async function declaredPackageNames(fs: FsGlob, config: UsablConfig): Promise<string[]> {
  const anchors = [
    path.dirname(config.discovery.routerFile.replace(/^\/+/u, '')),
    ...config.uiFileGlobs.map((glob) => staticPrefix(glob.replace(/^\/+/u, ''))),
    ...config.surfaces.flatMap((surface) => surface.files.map((file) => path.dirname(file.replace(/^\/+/u, '')))),
  ];
  const dirs = new Set<string>(['']);
  for (const anchor of anchors) {
    const inside = insideRepository(anchor === '' ? '.' : anchor);
    if (inside === null) continue;
    let dir = inside === '.' ? '' : inside.replace(/\/+$/u, '');
    while (dir !== '') {
      dirs.add(dir);
      const parent = path.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }
  for (const dir of await workspacePackageDirs(fs)) dirs.add(dir);
  const names = new Set<string>();
  for (const dir of [...dirs].sort()) {
    const manifest = await readManifest((file) => fs.readFile(file), dir);
    if (manifest.name !== null) names.add(manifest.name);
    for (const dependency of manifest.dependencies ?? []) names.add(dependency);
  }
  return [...names].sort();
}

/** Reads a file at the trusted ref, or null when that ref has no such file. */
export type TrustedRead = (file: string) => Promise<string | null>;

/**
 * A not-covered gap for each changed file that sits in a workspace package the configured app
 * depends on, directly or through another workspace package. The files given are the ones the
 * planner did not already count as UI, outside uiFileGlobs. The planner places a test file among
 * them by the test file rule before it keeps its gap (see test-files.ts). A repository with no
 * workspaces, a file outside every workspace package, a file in a package the app does not depend
 * on, and a file in the app's own package give no gap. When the workspace root cannot be read,
 * every file given is a gap that names the file, because any of them may be in such a package.
 *
 * trusted reads the trusted ref. When it is given, the workspace patterns and every package's
 * dependencies are the union of the tree and the trusted ref, so a change cannot remove the link
 * from the app to a package in the same change that edits the package.
 */
export async function workspaceDependencyGaps(
  fs: FsGlob,
  config: UsablConfig,
  files: readonly string[],
  trusted?: TrustedRead,
): Promise<CoverageGap[]> {
  return (await workspaceDependencies(fs, config, files, trusted)).files.map((entry) => entry.gap);
}

/** A changed file in a workspace package the app depends on: its gap, and the package folder. */
export interface WorkspaceDependencyFile {
  gap: CoverageGap;
  // The folder of the package the file sits in. Null when the workspace root could not be read, so
  // the package is not known.
  packageDir: string | null;
}

export interface WorkspaceDependencies {
  files: WorkspaceDependencyFile[];
  // The folders of every workspace package the app depends on, other than the app's own, sorted.
  dependedDirs: string[];
}

/**
 * The same as workspaceDependencyGaps, with the folder of the package each file sits in and the
 * folders of every package the app depends on, so the planner can place a test file in one of them
 * by the test file rule.
 */
export async function workspaceDependencies(
  fs: FsGlob,
  config: UsablConfig,
  files: readonly string[],
  trusted?: TrustedRead,
): Promise<WorkspaceDependencies> {
  const none: WorkspaceDependencies = { files: [], dependedDirs: [] };
  const candidates = [...new Set(files.filter((file) => !isInstalledPath(file) && !isDocumentation(file)))].sort();
  if (candidates.length === 0) return none;
  const patterns: string[] = [];
  for (const [read, refLabel] of [
    [(file: string) => fs.readFile(file), ''],
    ...(trusted === undefined ? [] : [[trusted, ' at the trusted ref'] as const]),
  ] as const) {
    try {
      patterns.push(...(await workspacePatterns(read)));
    } catch (err) {
      if (!(err instanceof UnreadableWorkspaceRoot)) throw err;
      return { files: candidates.map((file) => ({ gap: unreadableRootGap(file, err, refLabel), packageDir: null })), dependedDirs: [] };
    }
  }
  const dirs = await workspaceDirs(fs, [...new Set(patterns)]);
  if (dirs.length === 0) return none;

  const workspace: PackageManifest[] = [];
  for (const dir of dirs) workspace.push(await readManifestBoth(fs, trusted, dir));
  const root = await readManifestBoth(fs, trusted, '');
  const all = [root, ...workspace];
  const apps = appPackages(config, all);
  if (apps.length === 0) return none;
  const appDirs = new Set(apps.map((app) => app.dir));
  const changedOwners = new Set(candidates.map((file) => ownerOf(file, workspace)?.dir).filter((dir): dir is string => dir !== undefined));
  const reached = await dependencyClosure(fs, apps, workspace, changedOwners);

  const found: WorkspaceDependencyFile[] = [];
  for (const file of candidates) {
    const owner = ownerOf(file, workspace);
    if (owner === null || appDirs.has(owner.dir) || !reached.has(owner.dir)) continue;
    found.push({ gap: gapFor(file, owner, apps), packageDir: owner.dir });
  }
  return { files: found, dependedDirs: [...reached.keys()].filter((dir) => !appDirs.has(dir)).sort() };
}

/** A workspace package: its name and its folder. */
export interface WorkspacePackage {
  name: string;
  dir: string;
}

/**
 * The named workspace packages the repository root lists, sorted by name. Empty when the root lists
 * none or cannot be read. The import graph uses them to follow a bare import into a package folder.
 */
export async function workspacePackages(fs: FsGlob): Promise<WorkspacePackage[]> {
  const found: WorkspacePackage[] = [];
  for (const dir of await workspacePackageDirs(fs)) {
    const { name } = await readManifest((file) => fs.readFile(file), dir);
    if (name !== null) found.push({ name, dir });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * The source files of one workspace package, sorted: every file with a source extension under its
 * folder, outside node_modules.
 */
export async function packageSourceFiles(fs: FsGlob, dir: string): Promise<string[]> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const found = await fs.glob(SOURCE_EXTENSIONS.map((extension) => `${prefix}**/*.${extension}`));
  const files = found.map(insideRepository).filter((file): file is string => file !== null && !isInstalledPath(file));
  return [...new Set(files)].sort();
}
