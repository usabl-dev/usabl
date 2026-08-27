/**
 * Draft policy generation for first-run onboarding.
 * This unit infers config and route sidecars from the working tree.
 * It must never mint a verdict or consume the files it just wrote in the same run.
 */
import { posix } from 'node:path';
import type { UsablConfig } from '../contracts/index.js';
import type { RouteEntry, RouteManifest } from '../coverage/route-manifest.js';

const POLICY_FILES = ['usabl.config.json', 'usabl.routes.json'] as const;
const VITE_CONFIG_CANDIDATES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
const ROUTER_CANDIDATES = ['src/App.tsx', 'src/App.jsx', 'src/routes.tsx', 'src/router.tsx'];
const ALWAYS_GUARDED = [
  'usabl.config.json',
  'usabl.routes.json',
  '.usabl-evidence.json',
  '.usabl-waivers.json',
];
const ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

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

function screenIdFromUrl(url: string): string {
  const trimmed = url.startsWith('/') ? url.slice(1) : url;
  if (trimmed.length === 0) return 'root';
  return trimmed.replace(/\//g, '-');
}

function parseVitePort(raw: string): number | null {
  const match = raw.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d+)/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return Number(match[1]);
}

function parseLocalImports(raw: string): Map<string, string> {
  const imports = new Map<string, string>();
  const named = /import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of raw.matchAll(named)) {
    const names = match[1];
    const specifier = match[2];
    if (typeof names !== 'string' || typeof specifier !== 'string') {
      continue;
    }
    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0 || trimmed.startsWith('type ')) {
        continue;
      }
      const aliased = trimmed.split(/\s+as\s+/);
      const local = aliased[aliased.length - 1]?.trim();
      if (local !== undefined && local.length > 0) {
        imports.set(local, specifier);
      }
    }
  }
  const defaults = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of raw.matchAll(defaults)) {
    const local = match[1];
    const specifier = match[2];
    if (typeof local === 'string' && typeof specifier === 'string') {
      imports.set(local, specifier);
    }
  }
  return imports;
}

function parseRouteTags(raw: string): Array<{ path: string; component: string | null }> {
  const routes: Array<{ path: string; component: string | null }> = [];
  const tags = /<Route\b([^>]*?)\/>/g;
  for (const match of raw.matchAll(tags)) {
    const attrs = match[1];
    if (typeof attrs !== 'string') {
      continue;
    }
    const pathMatch = attrs.match(/\bpath\s*=\s*['"`]([^'"`]+)['"`]/);
    if (pathMatch === null || pathMatch[1] === undefined) {
      continue;
    }
    const path = pathMatch[1];
    if (path === '*') {
      continue;
    }
    const elementMatch = attrs.match(/\belement\s*=\s*\{\s*<\s*([A-Za-z_$][\w$]*)/);
    routes.push({ path, component: elementMatch?.[1] ?? null });
  }
  return routes;
}

async function resolveEntryFile(
  fs: InitFs,
  routerFile: string,
  specifier: string,
): Promise<string | null> {
  const resolved = posix.normalize(posix.join(posix.dirname(routerFile), specifier));
  if (resolved.startsWith('..') || posix.isAbsolute(resolved)) {
    return null;
  }
  const hasExtension = ENTRY_EXTENSIONS.some((ext) => resolved.endsWith(ext));
  const candidates = hasExtension
    ? [resolved]
    : ENTRY_EXTENSIONS.map((ext) => resolved + ext);
  for (const candidate of candidates) {
    if ((await fs.readFile(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}

export async function inferInit(fs: InitFs): Promise<InitDraft> {
  const notes: string[] = [];
  let appBaseUrl = 'http://127.0.0.1:5173';
  let viteSource: string | null = null;
  for (const candidate of VITE_CONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw === null) {
      continue;
    }
    viteSource = candidate;
    const port = parseVitePort(raw);
    if (port !== null) {
      appBaseUrl = `http://127.0.0.1:${port}`;
      notes.push(`Inferred appBaseUrl from ${candidate} port ${port}.`);
    } else {
      notes.push(`Review: ${candidate} has no server.port; using ${appBaseUrl}.`);
    }
    break;
  }
  if (viteSource === null) {
    notes.push(`Review: no Vite config found; using ${appBaseUrl}.`);
  }

  let routerFile = '';
  let routerRaw: string | null = null;
  for (const candidate of ROUTER_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw !== null && (raw.includes('<Route') || raw.includes('path='))) {
      routerFile = candidate;
      routerRaw = raw;
      notes.push(`Inferred router file ${candidate}.`);
      break;
    }
  }
  if (routerFile.length === 0) {
    notes.push('Review: no router file found. Routes sidecar will be empty.');
  }

  const routes: RouteEntry[] = [];
  if (routerRaw !== null) {
    const imports = parseLocalImports(routerRaw);
    const parsed = parseRouteTags(routerRaw);
    let attributed = 0;
    for (const route of parsed) {
      let entryFile: string | null = null;
      if (route.component !== null) {
        const specifier = imports.get(route.component);
        if (specifier !== undefined) {
          entryFile = await resolveEntryFile(fs, routerFile, specifier);
        }
      }
      if (entryFile !== null) {
        attributed += 1;
      } else {
        notes.push(`Review: ${route.path} has no proven entry file.`);
      }
      routes.push({
        screenId: screenIdFromUrl(route.path),
        url: route.path.startsWith('/') ? route.path : `/${route.path}`,
        entryFile,
      });
    }
    notes.push(`Attributed ${attributed} of ${routes.length} routes to local entry files.`);
    if (routerRaw.includes('path="*"') || routerRaw.includes("path='*'")) {
      notes.push('Review: skipped catch-all route path="*".');
    }
  }

  const srcTsx = await fs.glob(['src/**/*.tsx']);
  const uiFileGlobs = srcTsx.length > 0 ? ['src/**/*.tsx'] : [];
  const wideCandidates = [
    'src/main.tsx',
    'src/main.ts',
    'src/App.tsx',
    'src/App.jsx',
    'index.html',
    'vite.config.ts',
    'vite.config.js',
    ...(await fs.glob(['src/**/*.css'])),
  ];
  const wideBlastGlobs: string[] = [];
  for (const candidate of wideCandidates) {
    if ((await fs.readFile(candidate)) !== null && !wideBlastGlobs.includes(candidate)) {
      wideBlastGlobs.push(candidate);
    }
  }

  const origin = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`;
  const surfaces = routes.map((route) => ({
    id: route.screenId,
    url: new URL(route.url, origin).toString(),
    files: route.entryFile === null ? [] : [route.entryFile],
  }));

  const config: UsablConfig = {
    appBaseUrl,
    uiFileGlobs,
    discovery: {
      routerFile: routerFile.length > 0 ? routerFile : 'src/App.tsx',
      wideBlastGlobs,
    },
    surfaces,
    guardedPaths: [...ALWAYS_GUARDED],
  };

  notes.push('Review: these files are drafts. Merge only after you check routes, globs, and URLs.');

  return {
    config,
    routes: { routes },
    notes,
  };
}

export async function writeInitDrafts(
  fs: InitFs,
  draft: InitDraft,
  opts: { force: boolean },
): Promise<WriteInitResult> {
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
