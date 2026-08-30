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
// the app's Vite config.
export const OVERLAY_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
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

export function isOverlayWired(source: string): boolean {
  // Wiring needs both the import from usabl/vite and a call to the factory. Either one
  // alone is not proof, so we require both before we call a config already wired.
  const hasImport = /from\s*['"]usabl\/vite['"]/.test(source) && /\busablVitePluginFromConfig\b/.test(source);
  const hasCall = /usablVitePluginFromConfig\s*\(/.test(source);
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
