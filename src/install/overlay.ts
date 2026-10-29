/**
 * Overlay install generator for `usabl install --overlay`.
 * It first works out which bundler the app uses, Vite or webpack, from the config files it
 * finds and from the package.json scripts that run either one. When it finds both, or neither,
 * it refuses and names what it saw: a guess here once wrote a vite.config.ts into a webpack app,
 * a file nothing reads.
 *
 * Vite: no config but a script that runs vite, write a complete draft, which Vite then loads.
 * webpack: there is always a config, so there is nothing to write from scratch.
 * Either bundler: already wired, no-op. Present but not wired: refuse and hand over the exact
 * two lines, because proving a lossless insertion into an arbitrary operator config from text
 * alone is not something this generator will claim. A refusal is safer than a mangled config.
 */
import type { InstallFs, InstallResult } from './index.js';

// The same config candidates init inspects, so overlay and init agree on which file is
// the app's Vite config. The .cts and .cjs forms are included because Vite resolves them
// too. If we missed them, an operator whose only config is vite.config.cts would get a
// fresh vite.config.ts that Vite loads first, silently shadowing their real config.
export const OVERLAY_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];

// The draft we write when no Vite config exists. It matches the fixture's wiring: import
// the factory from the usabl/vite subpath and add it to the plugins array. The overlay is
// advisory only, so it never changes exit codes; the gate stays the only thing that blocks.
export const OVERLAY_DRAFT = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'

// usabl overlay wiring. This plugin projects the gate-owned Result inside the dev server
// as an advisory badge. It never changes exit codes: usabl=off and webdriver runs skip it.
export default defineConfig({
  plugins: [
    usablVitePluginFromConfig({ cwd: import.meta.dirname }),
  ],
})
`;

export type OverlayBundler = 'vite' | 'webpack';

export type OverlayPlan =
  | { action: 'write'; bundler: 'vite'; path: string; draft: string }
  | { action: 'already-wired'; bundler: OverlayBundler; path: string }
  // A config exists but does not wire the overlay. For webpack, esm says which import form the
  // config uses, so the lines handed over are ones it can take as written.
  | { action: 'refuse'; bundler: OverlayBundler; path: string; esm: boolean }
  // Both bundlers, or neither, were found. seen lists the evidence, so the message can name it.
  | { action: 'undetected'; reason: 'both' | 'neither'; path: string; seen: string[] };

// webpack configs at the root: webpack.config.js and the split layout patternfly-react-seed uses
// (webpack.common.js, webpack.dev.js, webpack.prod.js), in every extension webpack-cli loads.
const WEBPACK_CONFIG_GLOBS = ['webpack.*.js', 'webpack.*.cjs', 'webpack.*.mjs', 'webpack.*.ts', 'webpack.*.cts', 'webpack.*.mts'];

// Shown when nothing was found, so the message says exactly where install looked.
const LOOKED_FOR = [
  ...OVERLAY_CONFIG_CANDIDATES,
  'webpack.config.js (or webpack.*.js, .cjs, .mjs, .ts)',
  'package.json scripts that run vite or webpack',
];

// One shell command in a package.json script, split at the operators that start another one.
function commandsOf(script: string): string[] {
  return script.split(/&&|\|\||;|\|/).map((part) => part.trim());
}

// The vite command, as a word on its own: "vite", "vite build", "npx vite", "./node_modules/.bin/vite".
// vitest and vite-node are other tools and do not count.
function runsVite(command: string): boolean {
  return /(?:^|[\s/])vite(?=\s|$)/.test(command);
}

// webpack-cli or webpack-dev-server. webpack-bundle-analyzer and other webpack-* tools do not count.
function runsWebpack(command: string): boolean {
  return /(?:^|[\s/])(?:webpack|webpack-cli|webpack-dev-server)(?=\s|$)/.test(command);
}

// webpack serve and webpack-dev-server start the dev server, which is where the overlay runs.
function servesWebpack(command: string): boolean {
  return /(?:^|[\s/])(?:webpack(?:-cli)?\s+(?:serve|s|server)\b|webpack-dev-server(?=\s|$))/.test(command);
}

// The config file a command names with --config or -c, written as a relative path.
function configFlagOf(command: string): string | null {
  const match = /(?:^|\s)(?:--config|-c)(?:=|\s+)(['"]?)([^\s'"]+)\1/.exec(command);
  const path = match?.[2];
  if (path === undefined || path.startsWith('/') || path.split('/').includes('..')) {
    return null;
  }
  return path.replace(/^\.\//, '');
}

interface BundlerEvidence {
  viteConfigs: string[];
  viteScripts: string[];
  webpackConfigs: string[];
  webpackScripts: string[];
  // The webpack config a dev server script names, when there is one.
  webpackServeConfig: string | null;
}

async function readScripts(fs: InstallFs): Promise<Array<[string, string]>> {
  const raw = await fs.readFile('package.json');
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable package.json says nothing about the bundler. Config files still can.
    return [];
  }
  const scripts = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'scripts') : undefined;
  if (typeof scripts !== 'object' || scripts === null) {
    return [];
  }
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function collectEvidence(fs: InstallFs): Promise<BundlerEvidence> {
  const viteConfigs: string[] = [];
  for (const candidate of OVERLAY_CONFIG_CANDIDATES) {
    if ((await fs.readFile(candidate)) !== null) {
      viteConfigs.push(candidate);
    }
  }
  const webpackConfigs = new Set(await fs.glob(WEBPACK_CONFIG_GLOBS));
  const viteScripts: string[] = [];
  const webpackScripts: string[] = [];
  let webpackServeConfig: string | null = null;
  for (const [name, script] of await readScripts(fs)) {
    for (const command of commandsOf(script)) {
      const config = configFlagOf(command);
      if (runsVite(command)) {
        if (!viteScripts.includes(name)) viteScripts.push(name);
        if (config !== null && !viteConfigs.includes(config) && (await fs.readFile(config)) !== null) {
          viteConfigs.push(config);
        }
      }
      if (runsWebpack(command)) {
        if (!webpackScripts.includes(name)) webpackScripts.push(name);
        if (config !== null && (await fs.readFile(config)) !== null) {
          webpackConfigs.add(config);
          if (servesWebpack(command) && webpackServeConfig === null) {
            webpackServeConfig = config;
          }
        }
      }
    }
  }
  return { viteConfigs, viteScripts, webpackConfigs: [...webpackConfigs].sort(), webpackScripts, webpackServeConfig };
}

function describeEvidence(evidence: BundlerEvidence): string[] {
  return [
    ...evidence.viteConfigs,
    ...evidence.viteScripts.map((name) => `package.json script "${name}" (runs vite)`),
    ...evidence.webpackConfigs,
    ...evidence.webpackScripts.map((name) => `package.json script "${name}" (runs webpack)`),
  ];
}

// The webpack config the overlay belongs in: the one the dev server script names, then a config
// whose name says dev, then webpack.config.*, then the first one found.
function webpackDevConfig(evidence: BundlerEvidence): string | null {
  const configs = evidence.webpackConfigs;
  const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
  return (
    evidence.webpackServeConfig ??
    configs.find((path) => /^webpack\.(?:dev|development)\./.test(base(path))) ??
    configs.find((path) => /^webpack\.config\./.test(base(path))) ??
    configs[0] ??
    null
  );
}

// Whether a webpack config is an ES module, so the handed-over lines use import, not require.
function isEsmConfig(path: string, source: string): boolean {
  if (/\.(?:mjs|mts)$/.test(path)) {
    return true;
  }
  if (/\.(?:cjs|cts)$/.test(path)) {
    return false;
  }
  return /^\s*(?:import\s|export\s)/m.test(scrubSource(source, true));
}

// Walk the source once and return a copy with comments removed. String and template
// literal contents are removed too when blankStrings is set. This is string-aware so a
// `//` inside a URL literal is not mistaken for the start of a comment, and it is the
// reason a commented-out or quoted mention of the plugin never reads as real wiring.
function scrubSource(source: string, blankStrings: boolean): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) {
      break;
    }
    const nextChar = source[index + 1];
    // Comments are always dropped, whichever mode we are in.
    if (char === '/' && nextChar === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && nextChar === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    // Strings and template literals: consume to the matching close, honoring escapes. The
    // delimiters stay so structure reads normally; the contents drop when blankStrings is set.
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === undefined || inner === quote) {
          break;
        }
        if (inner === '\\') {
          if (!blankStrings) {
            out += source.slice(index, index + 2);
          }
          index += 2;
          continue;
        }
        if (!blankStrings) {
          out += inner;
        }
        index += 1;
      }
      if (index < source.length) {
        out += quote;
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function isOverlayWired(source: string): boolean {
  // Wiring needs both an active import from usabl/vite and an active call to the factory.
  // A commented-out or quoted mention must not count, so both checks run on scrubbed copies.
  const withoutComments = scrubSource(source, false);
  const codeOnly = scrubSource(source, true);

  // The import binding lives in code, while its module specifier is itself a string literal.
  // Checking on the comment-stripped copy (strings intact) lets the specifier survive while
  // a commented-out import line does not. Both the binding and the specifier must be present.
  //
  // The binding must sit inside one import's own brace list and that same statement must close on
  // 'usabl/vite'. [^{}]* (not [^;]*) keeps the match inside a single "{ ... }", so newlines are
  // allowed but the match cannot span statements. Without this bound, a semicolon-free file could
  // borrow the binding from `import { usablVitePluginFromConfig } from './fake'` and the specifier
  // from a later `export * from 'usabl/vite'`, reporting a config as wired when it is not.
  const hasImport =
    /import\s*\{[^{}]*\busablVitePluginFromConfig\b[^{}]*\}\s*from\s*['"]usabl\/vite['"]/.test(
      withoutComments,
    );

  // The factory call must survive in active code, not inside a comment or a string, so it is
  // checked on the copy with both comments removed and string contents blanked.
  const hasCall = /\busablVitePluginFromConfig\s*\(/.test(codeOnly);

  return hasImport && hasCall;
}

export function isWebpackOverlayWired(source: string): boolean {
  // The same rule as isOverlayWired: an active import or require of usabl/webpack that binds
  // UsablWebpackPlugin, and an active construction of it. Comments and strings never count.
  const withoutComments = scrubSource(source, false);
  const codeOnly = scrubSource(source, true);
  const hasImport =
    /import\s*\{[^{}]*\bUsablWebpackPlugin\b[^{}]*\}\s*from\s*['"]usabl\/webpack['"]/.test(withoutComments) ||
    /\{[^{}]*\bUsablWebpackPlugin\b[^{}]*\}\s*=\s*require\(\s*['"]usabl\/webpack['"]\s*\)/.test(withoutComments);
  const hasCall = /\bnew\s+UsablWebpackPlugin\s*\(/.test(codeOnly);
  return hasImport && hasCall;
}

async function planVite(fs: InstallFs, evidence: BundlerEvidence): Promise<OverlayPlan> {
  for (const candidate of evidence.viteConfigs) {
    const raw = await fs.readFile(candidate);
    if (raw === null) {
      continue;
    }
    // A config exists. If it already wires the overlay, we are done. If not, we refuse:
    // we cannot prove a safe, lossless edit to an operator file from a text scan.
    return isOverlayWired(raw)
      ? { action: 'already-wired', bundler: 'vite', path: candidate }
      : { action: 'refuse', bundler: 'vite', path: candidate, esm: true };
  }
  // A script runs vite and there is no config, so a full draft is safe to write and Vite reads it.
  return { action: 'write', bundler: 'vite', path: 'vite.config.ts', draft: OVERLAY_DRAFT };
}

async function planWebpack(fs: InstallFs, evidence: BundlerEvidence): Promise<OverlayPlan> {
  for (const config of evidence.webpackConfigs) {
    const raw = await fs.readFile(config);
    if (raw !== null && isWebpackOverlayWired(raw)) {
      return { action: 'already-wired', bundler: 'webpack', path: config };
    }
  }
  const target = webpackDevConfig(evidence);
  if (target === null) {
    // A script runs webpack with its built-in defaults and no config file. There is no file to
    // point at, so the lines go to whichever config the operator adds.
    return { action: 'refuse', bundler: 'webpack', path: 'webpack.config.js', esm: false };
  }
  const raw = (await fs.readFile(target)) ?? '';
  return { action: 'refuse', bundler: 'webpack', path: target, esm: isEsmConfig(target, raw) };
}

export async function planOverlay(fs: InstallFs): Promise<OverlayPlan> {
  const evidence = await collectEvidence(fs);
  const vite = evidence.viteConfigs.length > 0 || evidence.viteScripts.length > 0;
  const webpack = evidence.webpackConfigs.length > 0 || evidence.webpackScripts.length > 0;
  if (vite === webpack) {
    return {
      action: 'undetected',
      reason: vite ? 'both' : 'neither',
      path: '',
      seen: describeEvidence(evidence),
    };
  }
  return vite ? planVite(fs, evidence) : planWebpack(fs, evidence);
}

function overlayRefusalMessage(path: string): string {
  return [
    `Refusing to edit ${path}: usabl cannot prove a lossless insertion into an existing Vite config.`,
    'Add the overlay by hand. Add this import near the top:',
    "  import { usablVitePluginFromConfig } from 'usabl/vite'",
    'and add this entry to the plugins array:',
    '  usablVitePluginFromConfig({ cwd: import.meta.dirname }),',
  ].join('\n');
}

// The cwd the plugin needs is the app root, where usabl.config.json is. A config at the root is
// in that folder; a nested one names it relative to its own folder.
function webpackCwdExpression(path: string, esm: boolean): string {
  const depth = path.split('/').length - 1;
  const here = esm ? 'import.meta.dirname' : '__dirname';
  if (depth === 0) {
    return here;
  }
  const up = Array.from({ length: depth }, () => '..').join('/');
  // The plugin resolves its cwd, so the ES module form can name the parent folder as a plain join.
  return esm ? `${here} + '/${up}'` : `require('node:path').resolve(${here}, '${up}')`;
}

function webpackRefusalMessage(path: string, esm: boolean): string {
  const importLine = esm
    ? "  import { UsablWebpackPlugin } from 'usabl/webpack'"
    : "  const { UsablWebpackPlugin } = require('usabl/webpack')";
  return [
    `Found webpack. Refusing to edit ${path}: usabl cannot prove a lossless insertion into an existing webpack config.`,
    `Add the overlay by hand to the config your dev server uses (${path}). Add this near the top:`,
    importLine,
    'and add this entry to its plugins array, creating the array if the config has none:',
    `  new UsablWebpackPlugin({ cwd: ${webpackCwdExpression(path, esm)} }),`,
    'The plugin does nothing unless webpack runs in development mode, so a production build does not change.',
    ...(esm ? [] : ['require() of usabl/webpack needs Node.js 22.12 or later.']),
  ].join('\n');
}

function undetectedMessage(plan: Extract<OverlayPlan, { action: 'undetected' }>): string {
  if (plan.reason === 'both') {
    return [
      'Refusing to install the overlay: this app shows both Vite and webpack, and usabl will not guess which one serves it in development.',
      'Saw:',
      ...plan.seen.map((entry) => `  ${entry}`),
      'Add the overlay by hand to the dev config of the bundler you use. "usabl install --overlay --help" and the setup guide show the lines for each.',
    ].join('\n');
  }
  return [
    'Refusing to install the overlay: usabl found no Vite or webpack setup, so it cannot tell which config the dev server reads.',
    'Looked for:',
    ...LOOKED_FOR.map((entry) => `  ${entry}`),
    'If the app runs another dev server (for example rspack or Next.js), the overlay does not support it yet.',
  ].join('\n');
}

export async function writeOverlay(fs: InstallFs, plan: OverlayPlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    await fs.writeFile(plan.path, plan.draft);
    return {
      exitCode: 0,
      action: 'written',
      path: plan.path,
      message: `Wrote ${plan.path} with the usabl overlay plugin. Review this draft before you merge it.`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: plan.path,
      message: `${plan.path} already wires the usabl overlay plugin. No change.`,
    };
  }
  if (plan.action === 'undetected') {
    return { exitCode: 2, action: 'refused', path: plan.path, message: undetectedMessage(plan) };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: plan.bundler === 'webpack' ? webpackRefusalMessage(plan.path, plan.esm) : overlayRefusalMessage(plan.path),
  };
}
