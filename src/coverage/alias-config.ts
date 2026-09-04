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

  // Object form: alias: { '@': './src', ... } or path.resolve(__dirname, './src')
  const objectBlock = raw.match(/alias\s*:\s*\{([^}]+)\}/);
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
  const arrayEntries = raw.matchAll(
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

function mergeMappings(tsconfig: AliasMapping[], vite: AliasMapping[]): AliasMapping[] {
  const byPrefix = new Map<string, AliasMapping>();
  for (const mapping of tsconfig) {
    byPrefix.set(mapping.prefix, mapping);
  }
  // Vite wins on conflict for the same prefix.
  for (const mapping of vite) {
    byPrefix.set(mapping.prefix, mapping);
  }
  return [...byPrefix.values()].sort((a, b) => b.prefix.length - a.prefix.length);
}

export function resolveAliasSpecifier(
  specifier: string,
  mappings: AliasMapping[],
  _projectRoot: string,
): string | null {
  const ordered = [...mappings].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const mapping of ordered) {
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
  return (
    specifier.startsWith('@/') ||
    specifier.startsWith('~/') ||
    (specifier.startsWith('@') && !specifier.startsWith('@/'))
  );
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

  const merged = mergeMappings(tsconfigMappings, viteMappings);

  // ~/ maps to project root when no explicit ~/ mapping exists.
  if (!merged.some((m) => m.prefix === '~/')) {
    merged.push({ prefix: '~/', target: './' });
  }

  merged.sort((a, b) => b.prefix.length - a.prefix.length);

  const hasAliasConfig = tsconfigMappings.length > 0 || viteMappings.length > 0;

  return { mappings: merged, hasAliasConfig };
}
