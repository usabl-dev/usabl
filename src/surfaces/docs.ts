/**
 * Docs-output projection for a gated Result plus the design-intake requirement bundle.
 * This unit assembles read-only doc artifacts; it never recomputes findings or mints a verdict.
 * generateDocs runs the engine to get that Result, and only chooses which files it plans from.
 * It scrubs page-derived transcript text before egress because artifacts leave the trust boundary.
 */
import type { Deps, DocArtifact, FsGlob, RequirementBundle, Result, UsablConfig } from '../contracts/index.js';
import { parseDocsManifest } from '../coverage/docs-manifest.js';
import { generateAltTextManifest, generatePageAltTextManifest } from '../docs/alt-text-manifest.js';
import { generateAnnouncementSnippets } from '../docs/announcement-snippets.js';
import { generateKeyboardPaths } from '../docs/keyboard-paths.js';
import { run } from '../run.js';
import { scrubResult } from './scrub.js';

/**
 * Builds the full set of doc artifacts for a run.
 * Transcript-derived artifacts come from every scanned screen; the alt-text manifest is emitted
 * once per distinct content-requirement surface, sorted for stable output. A scanned screen that no
 * content requirement covers, and whose images the scan read, gets a manifest drafted from the
 * page instead, also sorted. Drafted entries are marked as such and never carry evidence.
 */
export function collectDocArtifacts(result: Result, bundle: RequirementBundle): DocArtifact[] {
  // Scrub first: the transcript generators strip control bytes but not credential-shaped values,
  // and this surface is egress for page-derived text.
  const safe = scrubResult(result);

  const artifacts: DocArtifact[] = [
    ...generateAnnouncementSnippets(safe),
    ...generateKeyboardPaths(safe),
  ];

  const contentSurfaces = [
    ...new Set(
      bundle.requirements
        .filter((requirement) => requirement.kind === 'content')
        .map((requirement) => requirement.surface),
    ),
  ].sort();

  for (const surface of contentSurfaces) {
    artifacts.push(generateAltTextManifest(safe, bundle, surface));
  }

  const drafted = safe.screens
    .filter((screen) => screen.images !== undefined && !contentSurfaces.includes(screen.screenId))
    .sort((a, b) => (a.screenId < b.screenId ? -1 : a.screenId > b.screenId ? 1 : 0));
  for (const screen of drafted) {
    artifacts.push(generatePageAltTextManifest(safe, screen));
  }

  return artifacts;
}

/**
 * Projects doc artifacts into a stdout-ready JSON envelope alongside the raw artifact list.
 */
export function projectDocs(
  result: Result,
  bundle: RequirementBundle,
): { json: string; artifacts: DocArtifact[] } {
  const artifacts = collectDocArtifacts(result, bundle);
  return { artifacts, json: JSON.stringify({ artifacts }, null, 2) };
}

/**
 * Every file in scope for the whole app: each file the UI globs match, each file a surface names,
 * and each source of a docs page. Fed to run() as the changed set, it makes every screen the
 * planners can reach come back affected, with no other change to how coverage is planned. A file
 * no screen owns still becomes a coverage gap, as it would in a change.
 *
 * A docs manifest that does not parse adds nothing here. run() reads the same manifest and
 * reports the failure itself.
 */
export async function wholeAppFiles(fs: FsGlob, config: UsablConfig): Promise<string[]> {
  const files = new Set<string>(config.uiFileGlobs.length === 0 ? [] : await fs.glob(config.uiFileGlobs));
  for (const surface of config.surfaces) {
    for (const file of surface.files) files.add(file);
  }
  let docsSources: string[] = [];
  try {
    docsSources = ((await parseDocsManifest(fs))?.pages ?? []).flatMap((page) => page.sources);
  } catch {
    docsSources = [];
  }
  for (const file of docsSources) files.add(file);
  return [...files].sort();
}

export interface DocsOptions {
  // Document every in-scope surface instead of only the ones the working-tree change touched.
  all: boolean;
}

/**
 * Runs the engine and projects its doc artifacts. This is a generator: the caller always exits 0
 * and nothing here reads or writes a verdict. Whole-app mode only widens the changed set run()
 * plans from. Honesty still comes from receipt binding alone, exactly as in the per-change mode.
 */
export async function generateDocs(
  deps: Deps,
  config: UsablConfig,
  opts: DocsOptions,
): Promise<{ json: string; artifacts: DocArtifact[] }> {
  const result = opts.all
    ? await run(deps, config, { changedFiles: await wholeAppFiles(deps.fs, config) })
    : await run(deps, config);
  return projectDocs(result, deps.requirements);
}
