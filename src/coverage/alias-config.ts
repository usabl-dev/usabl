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
}

export interface AliasConfig {
  mappings: AliasMapping[];
  hasAliasConfig: boolean;
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

function normalizeTarget(target: string, baseDir: string): string {
  let resolved = target.replace(/^\.\//, '');
  if (resolved.startsWith('/')) {
    return path.normalize(resolved).replace(/^\//, '') + (resolved.endsWith('/') ? '/' : '');
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

function parseTsconfigPaths(raw: string, configDir: string): AliasMapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const compilerOptions = parsed['compilerOptions'];
  if (!isRecord(compilerOptions)) {
    return [];
  }
  const paths = compilerOptions['paths'];
  if (!isRecord(paths)) {
    return [];
  }
  const baseUrl =
    typeof compilerOptions['baseUrl'] === 'string' ? compilerOptions['baseUrl'] : '.';
  const baseDir = path.normalize(path.join(configDir, baseUrl));

  const mappings: AliasMapping[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      continue;
    }
    const first = targets[0];
    if (typeof first !== 'string') {
      continue;
    }
    // Only wildcard pairs like "@/*" -> "src/*" are supported.
    if (!pattern.endsWith('/*') || !first.endsWith('/*')) {
      continue;
    }
    const prefix = ensureTrailingSlashForPrefix(pattern.slice(0, -2));
    const targetBase = first.slice(0, -2);
    const target = normalizeTarget(targetBase, baseDir);
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
    return normalizeTarget(inner, configDir);
  }
  const resolveMatch = trimmed.match(
    /path\.resolve\(\s*__dirname\s*,\s*['"`]([^'"`]+)['"`]\s*\)/,
  );
  if (resolveMatch?.[1] !== undefined) {
    return normalizeTarget(resolveMatch[1], configDir);
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
  const ordered: AliasMapping[] = [];
  const seen = new Set<string>();
  for (const mapping of vite) {
    if (!seen.has(mapping.prefix)) {
      seen.add(mapping.prefix);
      ordered.push(mapping);
    }
  }
  const tsconfigByLength = [...tsconfig].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const mapping of tsconfigByLength) {
    if (!seen.has(mapping.prefix)) {
      seen.add(mapping.prefix);
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

export function isAliasLikeSpecifier(specifier: string): boolean {
  // Only the conventional alias prefixes. A scoped npm package such as @patternfly/react-core also
  // starts with '@' but is a bare package, not an alias, so it must be ignored, not disclosed as an
  // unresolved alias. Non-conventional configured aliases stay unresolved (disclosed), which is the
  // safe direction.
  return specifier.startsWith('@/') || specifier.startsWith('~/');
}

export async function loadAliasConfig(fs: FsGlob): Promise<AliasConfig> {
  const tsconfigMappings: AliasMapping[] = [];
  for (const candidate of TSCONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw !== null) {
      tsconfigMappings.push(...parseTsconfigPaths(raw, path.dirname(candidate)));
    }
  }

  let viteMappings: AliasMapping[] = [];
  for (const candidate of VITE_CONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw !== null) {
      viteMappings = parseViteAliases(raw, candidate);
      break;
    }
  }

  // No invented "~/ -> ./" default. A tilde import only resolves when the project actually
  // configures it; otherwise it stays disclosed as alias-unconfigured, not silently attributed.
  const merged = mergeMappings(tsconfigMappings, viteMappings);

  const hasAliasConfig = tsconfigMappings.length > 0 || viteMappings.length > 0;

  return { mappings: merged, hasAliasConfig };
}
