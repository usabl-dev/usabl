/**
 * Alias configuration discovery for import-graph coverage planning.
 * Reads tsconfig paths and Vite resolve.alias only. It must never guess
 * dynamic alias expressions or traverse package imports.
 */
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

export interface AliasMapping {
  prefix: string;
  target: string;
  // A tsconfig paths entry with no wildcard, such as "@/theme": ["src/styles/theme.ts"], maps one
  // specifier to one file. The prefix is that specifier with a slash added, and only the
  // specifier itself matches it.
  exact?: true;
}

export interface AliasConfig {
  mappings: AliasMapping[];
  hasAliasConfig: boolean;
  // Mappings from other configs that also apply, each list in its own resolution order. An import
  // is resolved against `mappings` and against each of these, and when they disagree every file
  // found is followed. Absent when only one set of configs was read.
  otherSources?: AliasMapping[][];
}

const TSCONFIG_CANDIDATES = ['tsconfig.json', 'tsconfig.app.json'];
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A target, written relative to the repository root. A leading slash names the root of the
// project the config belongs to, which is the folder that holds the config: Vite reads '/src' as
// the src folder of its root.
function normalizeTarget(target: string, baseDir: string, rootDir = '.'): string {
  let resolved = target.replace(/^\.\//, '');
  if (resolved.startsWith('/')) {
    const rooted = path.normalize(path.join(rootDir, resolved)).replace(/^\//, '');
    return rooted + (resolved.endsWith('/') && !rooted.endsWith('/') ? '/' : '');
  }
  const joined = path.normalize(path.join(baseDir, resolved));
  if (joined.startsWith('..')) {
    return resolved.endsWith('/') ? `${resolved}/` : resolved;
  }
  return joined.endsWith('/') || target.endsWith('/') ? `${joined}/` : joined;
}

function ensureTrailingSlashForPrefix(prefix: string): string {
  if (prefix.endsWith('/*')) {
    return prefix.slice(0, -1);
  }
  if (!prefix.endsWith('/')) {
    return `${prefix}/`;
  }
  return prefix;
}

// One tsconfig file in an extends chain: the folder it sits in and its compilerOptions.
interface TsconfigLayer {
  dir: string;
  compilerOptions: Record<string, unknown>;
}

// How many configs an extends chain may hold. A real chain is two or three deep. The cap stops a
// planted chain from making discovery read without end.
const MAX_EXTENDS_DEPTH = 10;

// The configs a tsconfig extends, nearest first, the way TypeScript merges them: the file's own
// options win over what it extends, and in an extends list a later entry wins over an earlier one.
// Only a relative path is followed. A package name such as @tsconfig/node20 resolves through
// node_modules, which usabl does not read, and a path that leaves the repository is never read. A
// config that cannot be read or parsed ends its branch of the chain: the paths it may hold are not
// read, so an import through them stays unresolved and disclosed.
async function readTsconfigChain(
  fs: FsGlob,
  file: string,
  seen: Set<string>,
): Promise<TsconfigLayer[]> {
  if (seen.has(file) || seen.size >= MAX_EXTENDS_DEPTH) return [];
  seen.add(file);
  const raw = await fs.readFile(file);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const dir = path.dirname(file);
  const own = parsed['compilerOptions'];
  const layers: TsconfigLayer[] = [{ dir, compilerOptions: isRecord(own) ? own : {} }];
  const extendsRaw = parsed['extends'];
  const parents = typeof extendsRaw === 'string' ? [extendsRaw] : Array.isArray(extendsRaw) ? extendsRaw : [];
  for (const parent of [...parents].reverse()) {
    if (typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
    const joined = path.normalize(path.join(dir, parent));
    if (joined === '..' || joined.startsWith('../')) continue;
    layers.push(...(await readTsconfigChain(fs, joined.endsWith('.json') ? joined : `${joined}.json`, seen)));
  }
  return layers;
}

// The path aliases of a tsconfig chain. paths comes from the nearest config that sets it, whole,
// since a child's paths replace its parent's. Its targets are read from the nearest baseUrl, which
// is relative to the config that sets it, or, with no baseUrl, from the config that sets paths.
function tsconfigPathMappings(chain: readonly TsconfigLayer[]): AliasMapping[] {
  const pathsLayer = chain.find((layer) => isRecord(layer.compilerOptions['paths']));
  if (pathsLayer === undefined) return [];
  const paths = pathsLayer.compilerOptions['paths'] as Record<string, unknown>;
  const baseUrlLayer = chain.find((layer) => typeof layer.compilerOptions['baseUrl'] === 'string');
  const baseDir =
    baseUrlLayer === undefined
      ? pathsLayer.dir
      : path.normalize(path.join(baseUrlLayer.dir, baseUrlLayer.compilerOptions['baseUrl'] as string));

  const mappings: AliasMapping[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      continue;
    }
    const first = targets[0];
    if (typeof first !== 'string') {
      continue;
    }
    // A single-file entry, such as "@/theme" -> "src/styles/theme.ts", maps that one specifier.
    if (!pattern.includes('*') && !first.includes('*')) {
      mappings.push({
        prefix: ensureTrailingSlashForPrefix(pattern),
        target: normalizeTarget(first, baseDir, pathsLayer.dir).replace(/\/+$/u, ''),
        exact: true,
      });
      continue;
    }
    // Otherwise only wildcard pairs like "@/*" -> "src/*" are supported.
    if (!pattern.endsWith('/*') || !first.endsWith('/*')) {
      continue;
    }
    const prefix = ensureTrailingSlashForPrefix(pattern.slice(0, -2));
    const targetBase = first.slice(0, -2);
    const target = normalizeTarget(targetBase, baseDir, pathsLayer.dir);
    mappings.push({
      prefix,
      target: target.endsWith('/') ? target : `${target}/`,
    });
  }
  return mappings;
}

function parseViteAliasString(value: string, configDir: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith('`')) {
    const inner = trimmed.slice(1, trimmed.search(/['"`]\s*[,}]/));
    if (inner.length === 0) {
      return null;
    }
    return normalizeTarget(inner, configDir, configDir);
  }
  const resolveMatch = trimmed.match(
    /path\.resolve\(\s*__dirname\s*,\s*['"`]([^'"`]+)['"`]\s*\)/,
  );
  if (resolveMatch?.[1] !== undefined) {
    return normalizeTarget(resolveMatch[1], configDir, configDir);
  }
  return null;
}

function parseViteAliases(raw: string, configFile: string): AliasMapping[] {
  const configDir = path.dirname(configFile);
  const mappings: AliasMapping[] = [];
  const seenPrefixes = new Set<string>();

  // Only parse aliases inside the resolve block. A bare "alias:" match anywhere would let a
  // plugin option or unrelated object masquerade as resolve.alias and attribute a decoy file.
  const raw2 = extractResolveBlock(raw);
  if (raw2 === null) {
    return mappings;
  }

  // Object form: alias: { '@': './src', ... } or path.resolve(__dirname, './src')
  const objectBlock = raw2.match(/alias\s*:\s*\{([^}]+)\}/);
  if (objectBlock?.[1] !== undefined) {
    const entries = objectBlock[1].matchAll(
      /['"`]([^'"`]+)['"`]\s*:\s*((?:path\.resolve\([^)]+\)|['"`][^'"`]*['"`]|[^,}\n]+))/g,
    );
    for (const match of entries) {
      const find = match[1];
      const replacement = match[2];
      if (typeof find !== 'string' || typeof replacement !== 'string') {
        continue;
      }
      const target = parseViteAliasString(replacement, configDir);
      if (target === null) {
        continue;
      }
      const prefix = ensureTrailingSlashForPrefix(find);
      if (!seenPrefixes.has(prefix)) {
        seenPrefixes.add(prefix);
        mappings.push({
          prefix,
          target: target.endsWith('/') ? target : `${target}/`,
        });
      }
    }
  }

  // Array form: alias: [{ find: '@', replacement: './src' }, ...]
  const arrayEntries = raw2.matchAll(
    /\{\s*find\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*replacement\s*:\s*([^}]+)\}/g,
  );
  for (const match of arrayEntries) {
    const find = match[1];
    const replacement = match[2];
    if (typeof find !== 'string' || typeof replacement !== 'string') {
      continue;
    }
    const target = parseViteAliasString(replacement, configDir);
    if (target === null) {
      continue;
    }
    const prefix = ensureTrailingSlashForPrefix(find);
    if (!seenPrefixes.has(prefix)) {
      seenPrefixes.add(prefix);
      mappings.push({
        prefix,
        target: target.endsWith('/') ? target : `${target}/`,
      });
    }
  }

  return mappings;
}

// Returns the balanced-brace body of the first `resolve: { ... }` block, or null. Scoping alias
// parsing to this block is what keeps a decoy `alias:` elsewhere in the config from being read.
function extractResolveBlock(raw: string): string | null {
  const marker = raw.match(/\bresolve\s*:\s*\{/);
  if (marker?.index === undefined) {
    return null;
  }
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function mergeMappings(tsconfig: AliasMapping[], vite: AliasMapping[]): AliasMapping[] {
  // Order is the resolution rule, so do not sort by prefix length. Vite is the bundler authority,
  // and its aliases apply in declaration order (first match wins), so they come first as parsed.
  // tsconfig paths fill in only prefixes Vite does not define, longest-prefix first to match how
  // TypeScript picks the most specific mapping.
  // A single-file tsconfig entry matches before any wildcard, as TypeScript reads it.
  const ordered: AliasMapping[] = [];
  const seen = new Set<string>();
  const keyOf = (mapping: AliasMapping): string => `${mapping.exact === true ? '=' : '*'}${mapping.prefix}`;
  for (const mapping of vite) {
    if (!seen.has(keyOf(mapping))) {
      seen.add(keyOf(mapping));
      ordered.push(mapping);
    }
  }
  const tsconfigByLength = [...tsconfig].sort(
    (a, b) => Number(b.exact === true) - Number(a.exact === true) || b.prefix.length - a.prefix.length,
  );
  for (const mapping of tsconfigByLength) {
    if (!seen.has(keyOf(mapping))) {
      seen.add(keyOf(mapping));
      ordered.push(mapping);
    }
  }
  return ordered;
}

export function resolveAliasSpecifier(specifier: string, mappings: AliasMapping[]): string | null {
  // First match wins, in the order the mappings were resolved (see mergeMappings). Re-sorting here
  // would break Vite's declaration-order semantics and could resolve to a different file than the
  // bundler, which is a false-coverage risk.
  for (const mapping of mappings) {
    if (mapping.exact === true) {
      if (specifier === mapping.prefix.slice(0, -1)) return path.normalize(mapping.target);
      continue;
    }
    if (!specifier.startsWith(mapping.prefix) && specifier !== mapping.prefix.slice(0, -1)) {
      continue;
    }
    const rest =
      specifier === mapping.prefix.slice(0, -1)
        ? ''
        : specifier.slice(mapping.prefix.length);
    const target = mapping.target.endsWith('/')
      ? `${mapping.target}${rest}`
      : path.join(mapping.target, rest);
    return path.normalize(target);
  }
  return null;
}

/**
 * Every path an alias import resolves to, one per set of configs that maps it, sorted and without
 * repeats. Empty when no config maps it. More than one path means the configs disagree.
 */
export function resolveAliasSpecifierEachWay(specifier: string, config: AliasConfig): string[] {
  const found = new Set<string>();
  for (const mappings of [config.mappings, ...(config.otherSources ?? [])]) {
    const resolved = resolveAliasSpecifier(specifier, mappings);
    if (resolved !== null) found.add(resolved);
  }
  return [...found].sort();
}

export function isAliasLikeSpecifier(specifier: string): boolean {
  // Only the conventional alias prefixes. A scoped npm package such as @patternfly/react-core also
  // starts with '@' but is a bare package, not an alias, so it must be ignored, not disclosed as an
  // unresolved alias. Non-conventional configured aliases stay unresolved (disclosed), which is the
  // safe direction.
  return specifier.startsWith('@/') || specifier.startsWith('~/');
}

function under(dir: string, file: string): string {
  return dir === '' ? file : `${dir}/${file}`;
}

/**
 * The nearest folder at or above a file that holds one of the named configs, climbing to the
 * repository root. The repository root ('') when no folder below it holds one.
 */
async function nearestConfigDir(fs: FsGlob, fromFile: string, candidates: readonly string[]): Promise<string> {
  let dir = path.dirname(path.normalize(fromFile.replace(/^\/+/u, '')));
  while (dir !== '.' && dir !== '' && !dir.startsWith('..')) {
    for (const candidate of candidates) {
      if ((await fs.readFile(`${dir}/${candidate}`)) !== null) return dir;
    }
    dir = path.dirname(dir);
  }
  return '';
}

/**
 * The folders an app's aliases are read from, found by climbing from a file of the app, such as
 * its router file: the nearest folder that holds a tsconfig, and, found on its own, the nearest
 * folder that holds a Vite config. Each is the repository root ('') when no folder below it holds
 * one. An app folder often holds only one of the two, and the other then sits higher up.
 */
export async function aliasConfigDirs(fs: FsGlob, fromFile: string): Promise<{ tsconfigDir: string; viteDir: string }> {
  return {
    tsconfigDir: await nearestConfigDir(fs, fromFile, TSCONFIG_CANDIDATES),
    viteDir: await nearestConfigDir(fs, fromFile, VITE_CONFIG_CANDIDATES),
  };
}

async function tsconfigMappingsIn(fs: FsGlob, dir: string): Promise<AliasMapping[]> {
  const mappings: AliasMapping[] = [];
  for (const candidate of TSCONFIG_CANDIDATES) {
    mappings.push(...tsconfigPathMappings(await readTsconfigChain(fs, under(dir, candidate), new Set())));
  }
  return mappings;
}

async function viteMappingsIn(fs: FsGlob, dir: string): Promise<AliasMapping[]> {
  for (const name of VITE_CONFIG_CANDIDATES) {
    const candidate = under(dir, name);
    const raw = await fs.readFile(candidate);
    if (raw !== null) return parseViteAliases(raw, candidate);
  }
  return [];
}

/**
 * The aliases set by the tsconfig and Vite config in one folder, the repository root by default,
 * with every target written relative to the repository root. A tsconfig that extends another reads
 * the paths that config sets, as the compiler does.
 */
export async function loadAliasConfig(fs: FsGlob, dir = ''): Promise<AliasConfig> {
  return loadAliasConfigFrom(fs, dir, dir);
}

async function loadAliasConfigFrom(fs: FsGlob, tsconfigDir: string, viteDir: string): Promise<AliasConfig> {
  const tsconfigMappings = await tsconfigMappingsIn(fs, tsconfigDir);
  const viteMappings = await viteMappingsIn(fs, viteDir);
  // No invented "~/ -> ./" default. A tilde import only resolves when the project actually
  // configures it; otherwise it stays disclosed as alias-unconfigured, not silently attributed.
  return {
    mappings: mergeMappings(tsconfigMappings, viteMappings),
    hasAliasConfig: tsconfigMappings.length > 0 || viteMappings.length > 0,
  };
}

/**
 * The folders a bare import resolves under through a tsconfig baseUrl, sorted, for the app a file
 * belongs to: from the nearest tsconfig at or above the file and from the repository root
 * tsconfig, as loadAppAliasConfig reads them. A baseUrl is read from the nearest config in an
 * extends chain that sets it, relative to that config. A folder outside the repository is left out.
 * Empty when no config sets one.
 */
export async function loadBaseUrlDirs(fs: FsGlob, fromFile: string): Promise<string[]> {
  const { tsconfigDir } = await aliasConfigDirs(fs, fromFile);
  const found = new Set<string>();
  for (const dir of [...new Set([tsconfigDir, ''])]) {
    for (const candidate of TSCONFIG_CANDIDATES) {
      const chain = await readTsconfigChain(fs, under(dir, candidate), new Set());
      const layer = chain.find((entry) => typeof entry.compilerOptions['baseUrl'] === 'string');
      if (layer === undefined) continue;
      const baseDir = path.normalize(path.join(layer.dir, layer.compilerOptions['baseUrl'] as string)).replace(/\/+$/u, '');
      if (baseDir === '..' || baseDir.startsWith('../') || baseDir.startsWith('/')) continue;
      found.add(baseDir === '' ? '.' : baseDir);
    }
  }
  return [...found].sort();
}

/**
 * The aliases of the app a file belongs to. The app's set comes from the nearest tsconfig and the
 * nearest Vite config at or above the file, found on their own. When either sits below the
 * repository root, the root tsconfig and Vite config are read as a second set, as usabl read them
 * before it looked in app folders, so aliases are never read from fewer places. usabl cannot run
 * the build to learn which set wins, so an import the two sets map to different places resolves
 * both ways (see resolveAliasSpecifierEachWay).
 */
export async function loadAppAliasConfig(fs: FsGlob, fromFile: string): Promise<AliasConfig> {
  const { tsconfigDir, viteDir } = await aliasConfigDirs(fs, fromFile);
  const app = await loadAliasConfigFrom(fs, tsconfigDir, viteDir);
  if (tsconfigDir === '' && viteDir === '') return app;
  const root = await loadAliasConfig(fs);
  if (!root.hasAliasConfig || JSON.stringify(root.mappings) === JSON.stringify(app.mappings)) return app;
  return { ...app, hasAliasConfig: true, otherSources: [root.mappings] };
}
