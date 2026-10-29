/**
 * Draft policy generation for first-run onboarding.
 * This unit infers config and route sidecars from the working tree.
 * It must never mint a verdict, write waivers or evidence, or consume the
 * files it just wrote in the same run. A wrong mapping is worse than a gap.
 */
import { posix } from 'node:path';
import type { SurfaceConfig, UsablConfig } from '../contracts/index.js';
import { operatorText } from '../intake/config-error.js';
import type { RouteEntry, RouteManifest } from '../coverage/route-manifest.js';
import { isRouterSource, readRouterSource, screenIdFromUrl } from '../coverage/router-parse.js';
import { validateId } from '../intake/id-grammar.js';
import { STORAGE_STATE_ENV_VAR } from '../deps/session.js';
import { APP_INIT_REFUSAL, unusableIdsError, type UnusableId } from './unusable-ids.js';
import { loadAliasConfig, resolveAliasSpecifier, type AliasMapping } from '../coverage/alias-config.js';
import { readViteServer } from './vite-server.js';

// Init writes only these two drafts. Waivers stay human-authored judgment.
const POLICY_FILES = ['usabl.config.json', 'usabl.routes.json'] as const;
// Include the .cts and .cjs forms Vite also resolves, so init inspects the operator's real
// config instead of missing it and defaulting the origin.
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];
// The PatternFly seed keeps its route config and router in src/app/routes.tsx.
const ROUTER_CANDIDATES = [
  'src/App.tsx',
  'src/App.jsx',
  'src/routes.tsx',
  'src/router.tsx',
  'src/app/routes.tsx',
  'src/app/routes.jsx',
];
// Seed guardedPaths to match the engine's always-guarded set so a first draft
// cannot omit a ledger the gate later treats as trusted policy.
const ALWAYS_GUARDED = [
  'usabl.config.json',
  'usabl.routes.json',
  '.usabl-evidence.json',
  '.usabl-waivers.json',
];
const ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
// TypeScript written as ESM imports a file by the name it compiles to, so `./Page.js` can mean
// Page.ts or Page.tsx. Each written extension maps to the files it can name, itself included.
const WRITTEN_EXTENSION_FILES: ReadonlyArray<[string, string[]]> = [
  ['.js', ['.js', '.ts', '.tsx']],
  ['.jsx', ['.jsx', '.tsx']],
  ['.mjs', ['.mjs', '.mts']],
  ['.cjs', ['.cjs', '.cts']],
  ['.tsx', ['.tsx']],
  ['.ts', ['.ts']],
];

export interface InitFs {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface InitDraft {
  config: UsablConfig;
  routes: RouteManifest;
  notes: string[];
}

export interface WriteInitResult {
  ok: boolean;
  written: string[];
  refused: string[];
  message: string;
}

// The UI source globs init can draft, relative to an app folder.
const UI_GLOBS = ['src/**/*.tsx', 'src/**/*.jsx'];

// Folders that hold installed or built code, never an app to draft.
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'coverage']);
// Folders where a monorepo keeps its apps. An app here is found by its router file even when
// it has no Vite config, and its Vite config is looked for one level deeper than elsewhere.
const APP_PARENTS = ['packages', 'apps'];
// Where init looks for an app's Vite config below the root: two levels down anywhere, such as
// platform/ or frontend/web/, and three under packages/ or apps/, such as apps/group/web/. Going
// deeper everywhere would walk every installed package in node_modules.
const APP_VITE_FOLDERS = ['*', '*/*', ...APP_PARENTS.map((parent) => `${parent}/*/*`)];

function isProvenRoutePath(path: string): boolean {
  // Root-absolute app paths only. The router reader joins a nested path to its parent, so a
  // path that is still relative here was not proven. Protocol-relative and @ URLs can leave
  // the operator origin. Catch-alls are not screens.
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('@') && path !== '*';
}

// One-based line number of a source offset, the way an editor numbers lines.
function lineAtOffset(raw: string, offset: number): number {
  return raw.slice(0, offset).split('\n').length;
}

// What a route's import resolves to: one file, several candidates init will not choose between,
// or nothing proven.
type EntryResolution = { file: string } | { candidates: string[] } | null;

async function existingFiles(fs: InitFs, candidates: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const candidate of candidates) {
    if ((await fs.readFile(candidate)) !== null) {
      hits.push(candidate);
    }
  }
  return hits;
}

/**
 * The entry file an import specifier names. A relative specifier is resolved from the router file;
 * any other only through a path alias the project configures (tsconfig paths or Vite
 * resolve.alias), so a package import resolves to nothing.
 *
 * Candidates are tried in tiers, as bundlers do: a written extension names that file or its
 * TypeScript source (`./Page.js` can be Page.ts); with no extension, the file tier (`Page.tsx`,
 * `Page.ts`, `Page.jsx`, `Page.js`) comes before the directory tier (`Page/index.tsx` and the rest).
 * A file always wins over a directory index, in every bundler, so that order is not a guess. Inside
 * one tier the bundler's pick depends on its configured extension order, which init cannot read, so
 * more than one hit is disclosed and left unattributed: picking one could map the screen to a file
 * it does not render, and the committed sidecar would then hide that.
 */
async function resolveEntryFile(
  fs: InitFs,
  routerFile: string,
  specifier: string,
  aliases: readonly AliasMapping[],
): Promise<EntryResolution> {
  const target = specifier.startsWith('.')
    ? posix.join(posix.dirname(routerFile), specifier)
    : resolveAliasSpecifier(specifier, [...aliases]);
  if (target === null) {
    return null;
  }
  const resolved = posix.normalize(target);
  // Stay inside the project tree. A `..` after normalize is an unproven path,
  // not an entry file we are willing to attribute.
  if (resolved.startsWith('..') || posix.isAbsolute(resolved)) {
    return null;
  }
  const written = WRITTEN_EXTENSION_FILES.find(([ext]) => resolved.endsWith(ext));
  const tiers = written
    ? [written[1].map((ext) => resolved.slice(0, -written[0].length) + ext)]
    : [ENTRY_EXTENSIONS.map((ext) => resolved + ext), ENTRY_EXTENSIONS.map((ext) => `${resolved}/index${ext}`)];
  for (const tier of tiers) {
    const hits = await existingFiles(fs, tier);
    if (hits.length === 1 && hits[0] !== undefined) {
      return { file: hits[0] };
    }
    if (hits.length > 1) {
      return { candidates: [...hits].sort() };
    }
  }
  return null;
}

function surfaceUrl(baseUrl: string, routePath: string): string | null {
  try {
    const origin = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const expectedOrigin = new URL(baseUrl).origin;
    const resolved = new URL(routePath, origin);
    // Same origin lock as coverage planning. A draft surface off the declared
    // app origin would point later scans at the wrong host.
    if (resolved.origin !== expectedOrigin) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

export interface InferInitOptions {
  // Whether the operator ran init with a storage state configured. That is the operator saying
  // this application is scanned signed in, which is the strongest sign init can read that it
  // needs a login. Absent means no session was configured.
  sessionConfigured?: boolean;
  // The app folder to draft, relative to the repository root, from `usabl init --app <dir>`.
  // Absent means the root app, or the one app init finds below the root.
  appDir?: string;
}

/**
 * The app folder from `--app`, as a clean repository-relative path with no trailing slash.
 *
 * Everything init writes is relative to the repository root, because CODEOWNERS, the trusted-ref
 * guard, and the planner all read paths from there. A folder outside the repository, or one with
 * no files, is refused: drafting it would write globs that match nothing in this tree.
 */
async function normalizeAppDir(fs: InitFs, appDir: string): Promise<string> {
  const cleaned = posix.normalize(appDir.trim().split('\\').join('/')).replace(/\/+$/, '');
  if (cleaned === '.' || cleaned === '') {
    return '';
  }
  if (posix.isAbsolute(cleaned) || cleaned === '..' || cleaned.startsWith('../')) {
    throw new Error(
      `usabl init refused --app ${operatorText(appDir)}: the app folder must be a folder inside this repository, ` +
        'written relative to its root, such as packages/web. Nothing was written.',
    );
  }
  // Two levels is enough to tell an app folder from a missing one, without walking its packages.
  if ((await fs.glob([`${cleaned}/*`, `${cleaned}/*/*`])).length === 0) {
    throw new Error(
      `usabl init refused --app ${operatorText(cleaned)}: that folder has no files in this repository. ` +
        'Check the path, relative to the repository root. Nothing was written.',
    );
  }
  return cleaned;
}

function isSkippedPath(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_FOLDERS.has(segment) || segment.startsWith('.'));
}

/**
 * The app folders below the repository root: each folder with a Vite config where
 * APP_VITE_FOLDERS looks, and each folder under packages/ or apps/ with a router file.
 * Installed and built code is skipped. Sorted, so the refusal reads the same on every run.
 */
async function findAppDirs(fs: InitFs): Promise<string[]> {
  const patterns: string[] = [];
  for (const folder of APP_VITE_FOLDERS) {
    patterns.push(...VITE_CONFIG_CANDIDATES.map((name) => `${folder}/${name}`));
  }
  for (const parent of APP_PARENTS) {
    patterns.push(...ROUTER_CANDIDATES.map((candidate) => `${parent}/*/${candidate}`));
  }
  const dirs = new Set<string>();
  for (const file of await fs.glob(patterns)) {
    if (isSkippedPath(file)) continue;
    const routerSuffix = ROUTER_CANDIDATES.find((candidate) => file.endsWith(`/${candidate}`));
    if (routerSuffix !== undefined && APP_PARENTS.some((parent) => file.startsWith(`${parent}/`))) {
      const raw = await fs.readFile(file);
      if (raw !== null && isRouterSource(raw)) dirs.add(file.slice(0, -routerSuffix.length - 1));
      continue;
    }
    dirs.add(posix.dirname(file));
  }
  return [...dirs].sort();
}

// Whether the repository root holds the app itself: a Vite config, a router file, or UI source.
async function rootIsApp(fs: InitFs): Promise<boolean> {
  for (const candidate of [...VITE_CONFIG_CANDIDATES, ...ROUTER_CANDIDATES]) {
    if ((await fs.readFile(candidate)) !== null) return true;
  }
  return (await fs.glob(UI_GLOBS)).length > 0;
}

// The app folder init drafts, and a note that says how it was chosen. More than one candidate is
// refused, because drafting the wrong app would write a config that checks the other app's files.
async function chooseAppDir(fs: InitFs, appDir: string | undefined): Promise<{ dir: string; note: string | null }> {
  if (appDir !== undefined) {
    const dir = await normalizeAppDir(fs, appDir);
    return { dir, note: dir === '' ? null : `Drafting the app in ${dir}, from --app.` };
  }
  if (await rootIsApp(fs)) {
    return { dir: '', note: null };
  }
  const found = await findAppDirs(fs);
  if (found.length === 1 && found[0] !== undefined) {
    return {
      dir: found[0],
      note: `Review: drafting the app in ${found[0]}, the one app found below the repository root. Run usabl init --app <dir> to draft another folder.`,
    };
  }
  if (found.length > 1) {
    throw new Error(
      [
        `usabl init found more than one app and will not pick one, because a config drafted for the wrong app checks the wrong files. Nothing was written. The apps it found:`,
        ...found.map((dir) => `  ${operatorText(dir)}`),
        `Run usabl init --app <dir> with the app to check, for example: usabl init --app ${operatorText(found[0] ?? '')}`,
      ].join('\n'),
    );
  }
  return { dir: '', note: null };
}

function packageJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Review notes for the workspace packages an app folder depends on. Their files sit outside the
 * app's uiFileGlobs, so a change to a shared component the app renders reads as nothing to check.
 * init does not add their globs itself: it cannot tell which of a package's files the app renders,
 * and a glob that is too wide would queue scans for files the app never shows.
 */
async function workspaceDependencyNotes(fs: InitFs, appDir: string): Promise<string[]> {
  const app = packageJson(await fs.readFile(under(appDir, 'package.json')));
  if (app === null) return [];
  const depends = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = app[field];
    if (typeof deps === 'object' && deps !== null) for (const name of Object.keys(deps)) depends.add(name);
  }
  const notes: string[] = [];
  const manifests = await fs.glob(APP_PARENTS.map((parent) => `${parent}/*/package.json`));
  for (const manifest of [...manifests].sort()) {
    const dir = posix.dirname(manifest);
    if (dir === appDir || isSkippedPath(manifest)) continue;
    const name = packageJson(await fs.readFile(manifest))?.['name'];
    if (typeof name !== 'string' || !depends.has(name)) continue;
    notes.push(
      `Review: ${appDir} depends on ${operatorText(name)} in ${dir}, and its files are not in uiFileGlobs, so a ` +
        'change there reads as nothing to check. If the app renders components from it, add their files to ' +
        `uiFileGlobs, such as ${dir}/src/**/*.tsx.`,
    );
  }
  return notes;
}

/**
 * The path aliases an app's own tsconfig and Vite config set, with targets relative to the
 * repository root. An app folder's bundler and compiler read the configs in that folder, not the
 * root's, so in --app mode those are the configs read. A target that no file matches leaves the
 * route unattributed, which is the safe direction.
 */
async function appAliases(fs: InitFs, appDir: string): Promise<AliasMapping[]> {
  if (appDir === '') return (await loadAliasConfig(fs)).mappings;
  const scoped = { readFile: (path: string) => fs.readFile(under(appDir, path)), glob: fs.glob };
  return (await loadAliasConfig(scoped)).mappings.map(({ prefix, target }) => {
    const joined = posix.normalize(posix.join(appDir, target));
    return { prefix, target: target.endsWith('/') && !joined.endsWith('/') ? `${joined}/` : joined };
  });
}

function under(dir: string, path: string): string {
  return dir === '' ? path : `${dir}/${path}`;
}

// Route path segments that name a sign-in, sign-out, or identity step. A naming convention, not
// proof, which is fine here: it only decides whether init prints a recommendation, and a
// recommendation on an application that needs no login costs the operator one line to ignore.
const SIGN_IN_SEGMENT = /^(login|log-in|logon|signin|sign-in|sign_in|logout|log-out|signout|sign-out|auth|sso)$/i;

function signInRoutePath(routes: readonly RouteEntry[]): string | null {
  for (const route of routes) {
    if (route.url.split('/').some((segment) => SIGN_IN_SEGMENT.test(segment))) {
      return route.url;
    }
  }
  return null;
}

/**
 * The readiness signal recommendation for a login-gated application.
 *
 * A scan whose session has died can be handed a sign-in page instead of the screen it asked for.
 * The session rules catch a refused data request, a password field, and a redirect to a page with a
 * password field. They do not catch a passkey prompt, a magic-link page, or an authentication wall
 * that answers 200 to everything: those are scored as the screen. Only a declared readiness signal
 * tells those apart, and only the operator knows what each screen shows, so init recommends one
 * for every screen and writes none itself. A guessed selector would be worse than none, because a
 * selector that a sign-in page also matches reads as proof the screen rendered.
 */
function readinessRecommendation(reason: string, surfaces: readonly SurfaceConfig[]): string[] {
  if (surfaces.length === 0) {
    return [];
  }
  return [
    `Review: this application looks login-gated (${reason}). Add a reachedWhen readiness signal to ` +
      'every surface: a selector for content only that screen has, such as its own table or heading, ' +
      'a response path for a data request only that screen makes, such as "/api/users", or both. ' +
      'Without one, a sign-in page with no password field and no refused request, such as a passkey ' +
      'or magic-link page, is scored as the screen.',
    ...surfaces.map(
      (surface) =>
        `Review: surface "${operatorText(surface.id)}" has no reachedWhen readiness signal yet.`,
    ),
  ];
}

/**
 * The appBaseUrl to draft from the app's Vite config, and the notes that say where it came from.
 * Vite's defaults (port 5173, http) fill in a setting the config leaves out. A setting written as
 * code is never guessed: the default is used and a Review note says it could not be read.
 */
function draftBaseUrl(viteFile: string | null, raw: string | null): { appBaseUrl: string; notes: string[] } {
  const fallback = 'http://127.0.0.1:5173';
  const setIt = `Set appBaseUrl in usabl.config.json to the URL your dev server serves.`;
  if (viteFile === null || raw === null) {
    return { appBaseUrl: fallback, notes: [`Review: no Vite config found; using ${fallback}. ${setIt}`] };
  }
  const server = readViteServer(raw, viteFile);
  const notes: string[] = [];
  const unread: string[] = [];
  if ('unread' in server.port) unread.push('server.port');
  if ('unread' in server.https) unread.push('server.https');
  const port = 'value' in server.port ? server.port.value : 5173;
  const https = 'value' in server.https && server.https.value;
  const appBaseUrl = `${https ? 'https' : 'http'}://127.0.0.1:${port}`;
  if (unread.length > 0) {
    notes.push(
      `Review: ${viteFile} sets ${unread.join(' and ')} with code usabl does not run, so it could not read ` +
        `${unread.length === 1 ? 'it' : 'them'}. Using ${appBaseUrl}. ${setIt}`,
    );
  }
  if ('value' in server.port) {
    notes.push(`Inferred appBaseUrl from ${viteFile}: port ${port}, ${https ? 'https' : 'http'}.`);
  } else if ('absent' in server.port) {
    notes.push(`Review: ${viteFile} has no server.port; using ${appBaseUrl}, the Vite default port.`);
  }
  return { appBaseUrl, notes };
}

export async function inferInit(fs: InitFs, options: InferInitOptions = {}): Promise<InitDraft> {
  const notes: string[] = [];
  const app = await chooseAppDir(fs, options.appDir);
  if (app.note !== null) notes.push(app.note);
  const appFile = (path: string): string => under(app.dir, path);
  if (app.dir !== '') notes.push(...(await workspaceDependencyNotes(fs, app.dir)));

  let viteFile: string | null = null;
  let viteRaw: string | null = null;
  for (const candidate of VITE_CONFIG_CANDIDATES.map(appFile)) {
    const raw = await fs.readFile(candidate);
    if (raw !== null) {
      viteFile = candidate;
      viteRaw = raw;
      break;
    }
  }
  const base = draftBaseUrl(viteFile, viteRaw);
  const appBaseUrl = base.appBaseUrl;
  notes.push(...base.notes);

  let routerFile = '';
  let routerRaw: string | null = null;
  for (const candidate of ROUTER_CANDIDATES.map(appFile)) {
    const raw = await fs.readFile(candidate);
    if (raw !== null && isRouterSource(raw)) {
      routerFile = candidate;
      routerRaw = raw;
      notes.push(`Inferred router file ${candidate}.`);
      break;
    }
  }
  if (routerFile.length === 0) {
    notes.push(`Review: no router file found (looked for ${ROUTER_CANDIDATES.map(appFile).join(', ')}).`);
  }

  const routes: RouteEntry[] = [];
  const unusable: UnusableId[] = [];
  if (routerRaw !== null) {
    const read = readRouterSource(routerRaw, routerFile);
    const imports = read.localImports;
    const parsed = read.routes;
    const aliases = read.bareImports.size > 0 ? await appAliases(fs, app.dir) : [];
    if (read.dataRouter) {
      notes.push('Review: data-router routes detected; verify entry file attribution.');
    }
    // A route the parser found but could not read is not in the draft. A written sidecar takes
    // precedence over the router, and usabl never scans a route the sidecar leaves out, so each one
    // is named here by file and line for the operator to add by hand. A router file that does not
    // parse comes back as one such entry.
    for (const gap of read.unreadable) {
      const where = gap.line === null || gap.wholeFile === true ? routerFile : `${routerFile} line ${gap.line}`;
      notes.push(
        `Review: ${where}: ${gap.reason} The draft usabl.routes.json does not list it, and usabl never ` +
          'scans a route that usabl.routes.json leaves out. Add the route by hand before you merge.',
      );
    }
    // A route list read on an assumption is in the draft. The operator confirms the assumption.
    for (const entry of read.assumed) {
      const where = entry.line === null ? routerFile : `${routerFile} line ${entry.line}`;
      notes.push(`Review: ${where}: ${entry.reason}`);
    }
    let attributed = 0;
    for (const route of parsed) {
      const where = `${routerFile} line ${lineAtOffset(routerRaw, route.offset)}`;
      if (!isProvenRoutePath(route.path)) {
        notes.push(
          `Review: ${where}: skipped unproven route path "${route.path}". Nested or relative paths are not attributed.`,
        );
        continue;
      }
      let entryFile: string | null = null;
      let entryCandidates: string[] = [];
      const specifier =
        route.component !== null
          ? (imports.get(route.component) ?? read.bareImports.get(route.component))
          : route.entryImport;
      if (specifier !== undefined) {
        const resolution = await resolveEntryFile(fs, routerFile, specifier, aliases);
        if (resolution !== null && 'file' in resolution) {
          entryFile = resolution.file;
        } else if (resolution !== null) {
          entryCandidates = resolution.candidates;
        }
      }
      // Ask the question the parser is going to ask, at the point the id is made. A route path
      // can hold a raw space, a joining character, or a blank glyph, and the derived id would
      // carry it, so writing that route would produce a sidecar usabl then refuses to read. The
      // route is not skipped either: a written sidecar takes precedence over router fallback and
      // the planner records no gap for a route that is not in it, so a sidecar without this route
      // would let a change to a shared entry file or a wide-blast file look fully checked while
      // the route is never scanned. Every such route is collected so the whole draft can be
      // refused at once. The route is named by file and line, never by its path, because the
      // path is what carries the refused character. The line comes from the offset the parser
      // recorded for the path it read, so it is the line of that declaration and not the first
      // place the same text appears in the file, such as a comment.
      const screenId = screenIdFromUrl(route.path);
      const refusal = validateId(screenId);
      if (!refusal.ok) {
        unusable.push({
          source: where,
          origin: 'the screen id derived from the route path there',
          refusal,
        });
        continue;
      }
      // Missing attribution stays null. Guessing an entry file would hide a
      // coverage gap behind a mapping we cannot prove.
      if (entryFile !== null) {
        attributed += 1;
      } else if (entryCandidates.length > 0) {
        notes.push(
          `Review: ${where}: ${route.path} has no proven entry file. Its import matches more than one file: ` +
            `${entryCandidates.join(', ')}. Set entryFile in usabl.routes.json to the file the route renders.`,
        );
      } else {
        notes.push(`Review: ${where}: ${route.path} has no proven entry file.`);
      }
      routes.push({
        screenId,
        url: route.path,
        entryFile,
      });
    }
    notes.push(`Attributed ${attributed} of ${routes.length} routes to local entry files.`);
    if (routerRaw.includes('path="*"') || routerRaw.includes("path='*'")) {
      notes.push('Review: skipped catch-all route path="*".');
    }
  }

  // Refuse once every route has been seen, so one run shows the whole fix.
  if (unusable.length > 0) {
    throw unusableIdsError(APP_INIT_REFUSAL, unusable);
  }

  // A config with no UI globs counts no change as a UI change, so every run reads as idle and no
  // run can ever produce a verdict. init refuses to write one rather than leave it to be noticed.
  const uiFileGlobs: string[] = [];
  for (const glob of UI_GLOBS.map(appFile)) {
    if ((await fs.glob([glob])).length > 0) uiFileGlobs.push(glob);
  }
  if (uiFileGlobs.length === 0) {
    const where = app.dir === '' ? 'the repository root' : app.dir;
    throw new Error(
      `usabl init found no UI files in ${operatorText(where)} (it looked for ${UI_GLOBS.map(appFile).join(' and ')}), ` +
        'so nothing was written. A config with empty uiFileGlobs treats no change as a UI change, so every run ' +
        'would read as nothing to check. If the app is in a folder below the root, run usabl init --app <dir>. ' +
        'Otherwise write usabl.config.json by hand and set uiFileGlobs to the files that render your UI.',
    );
  }
  // The router file itself can change every route, so it is wide blast too. src/index.tsx and
  // src/index.html are the shell in apps built like the PatternFly seed. routerFile already carries
  // the app folder; every other candidate is written relative to the app folder.
  const wideCandidates = [
    ...[
      'src/main.tsx',
      'src/main.ts',
      'src/index.tsx',
      'src/App.tsx',
      'src/App.jsx',
    ].map(appFile),
    ...(routerFile.length > 0 ? [routerFile] : []),
    ...['index.html', 'src/index.html', 'vite.config.ts', 'vite.config.js'].map(appFile),
    ...(await fs.glob([appFile('src/**/*.css')])),
  ];
  const wideBlastGlobs: string[] = [];
  for (const candidate of wideCandidates) {
    if ((await fs.readFile(candidate)) !== null && !wideBlastGlobs.includes(candidate)) {
      wideBlastGlobs.push(candidate);
    }
  }

  const origin = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`;
  const surfaces: SurfaceConfig[] = [];
  for (const route of routes) {
    const url = surfaceUrl(appBaseUrl, route.url);
    if (url === null) {
      notes.push(`Review: skipped surface URL for ${operatorText(route.url)}; it leaves ${origin}.`);
      continue;
    }
    // Every route here already passed the id grammar when its id was derived above, so a surface
    // taken from it is one the parser will accept.
    surfaces.push({
      id: route.screenId,
      url,
      files: route.entryFile === null ? [] : [route.entryFile],
      // Every surface here takes its id from a discovered route by construction, so the config has
      // to say the two are one screen. Without it the planner refuses the pair, because it cannot
      // tell an intended url override from two different screens and will not guess from the url.
      overridesDiscoveredRoute: true,
    });
  }

  const config: UsablConfig = {
    appBaseUrl,
    uiFileGlobs,
    discovery: {
      routerFile: routerFile.length > 0 ? routerFile : appFile('src/App.tsx'),
      wideBlastGlobs,
    },
    surfaces,
    guardedPaths: [...ALWAYS_GUARDED],
  };

  const signInRoute = signInRoutePath(routes);
  const loginReason =
    options.sessionConfigured === true
      ? `${STORAGE_STATE_ENV_VAR} is set, so scans run signed in`
      : signInRoute === null
        ? null
        : `the router has a sign-in route, ${operatorText(signInRoute)}`;
  if (loginReason !== null) {
    notes.push(...readinessRecommendation(loginReason, surfaces));
  }

  notes.push('Review: these files are drafts. Merge only after you check routes, globs, and URLs.');

  return {
    config,
    // init authors the sidecar, so the manifest it hands back is a sidecar manifest.
    routes: { routes, source: 'sidecar' },
    notes,
  };
}

export async function writeInitDrafts(
  fs: InitFs,
  draft: InitDraft,
  opts: { force: boolean },
): Promise<WriteInitResult> {
  // Existing policy is operator-owned. Overwrite is explicit so init cannot
  // clobber a reviewed sidecar during a later re-run.
  const refused: string[] = [];
  if (!opts.force) {
    for (const path of POLICY_FILES) {
      if ((await fs.readFile(path)) !== null) {
        refused.push(path);
      }
    }
  }
  if (refused.length > 0) {
    return {
      ok: false,
      written: [],
      refused,
      message: `Refusing to overwrite ${refused.join(', ')} without --force.`,
    };
  }

  const written: string[] = [];
  await fs.writeFile('usabl.config.json', `${JSON.stringify(draft.config, null, 2)}\n`);
  written.push('usabl.config.json');
  // An empty sidecar is not a draft of the routes: it takes precedence over the router and lists
  // no screens, so it would read as a decision that there is nothing to scan. With no route
  // derived, init writes none and says what to do instead.
  if (draft.routes.routes.length === 0) {
    return {
      ok: true,
      written,
      refused: [],
      message:
        `Wrote ${written.join(', ')}. usabl could not derive any route from source, so it did not write ` +
        'usabl.routes.json: an empty one would list no screens. Map each screen by hand: add a surface to ' +
        '"surfaces" in usabl.config.json with its id, url, and the files it renders, or write the routes into ' +
        'usabl.routes.json. Until then, usabl check reports a changed UI file as not covered.',
    };
  }
  await fs.writeFile('usabl.routes.json', `${JSON.stringify(draft.routes, null, 2)}\n`);
  written.push('usabl.routes.json');
  return {
    ok: true,
    written,
    refused: [],
    message: `Wrote ${written.join(', ')}.`,
  };
}

export function formatInitReport(draft: InitDraft, result: WriteInitResult): string {
  const lines = [result.message, ...draft.notes];
  return `${lines.join('\n')}\n`;
}
