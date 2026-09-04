/**
 * Overlay install generator for `usabl install --overlay`.
 * It wires the advisory Vite overlay plugin into the app's Vite config.
 * Absent config: write a complete draft. Already wired: no-op. Present but not wired:
 * refuse and hand over the exact two lines, because proving a lossless insertion into an
 * arbitrary operator config from text alone is not something this generator will claim.
 * A refusal is safer than a mangled config.
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

export type OverlayPlan =
  | { action: 'write'; path: string; draft: string }
  | { action: 'already-wired'; path: string }
  | { action: 'refuse'; path: string };

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
  // [^;]* (not [^;\n]*) so that multi-line imports are accepted. An import declaration
  // cannot contain a semicolon before its closing from-clause, so stopping at ; is a sound
  // statement boundary without also stopping at every newline.
  const hasImport =
    /import\b[^;]*\busablVitePluginFromConfig\b[^;]*from\s*['"]usabl\/vite['"]/.test(withoutComments);

  // The factory call must survive in active code, not inside a comment or a string, so it is
  // checked on the copy with both comments removed and string contents blanked.
  const hasCall = /\busablVitePluginFromConfig\s*\(/.test(codeOnly);

  return hasImport && hasCall;
}

export async function planOverlay(fs: InstallFs): Promise<OverlayPlan> {
  for (const candidate of OVERLAY_CONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw === null) {
      continue;
    }
    // A config exists. If it already wires the overlay, we are done. If not, we refuse:
    // we cannot prove a safe, lossless edit to an operator file from a text scan.
    return isOverlayWired(raw) ? { action: 'already-wired', path: candidate } : { action: 'refuse', path: candidate };
  }
  // No config found, so a full draft is safe to write.
  return { action: 'write', path: 'vite.config.ts', draft: OVERLAY_DRAFT };
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
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: overlayRefusalMessage(plan.path),
  };
}
