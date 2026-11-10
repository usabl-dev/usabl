/**
 * Docs-output projection for a gated Result plus the design-intake requirement bundle.
 * This unit assembles read-only doc artifacts; it never recomputes findings or mints a verdict.
 * generateDocs runs the engine to get that Result, and only chooses which files it plans from.
 * It scrubs page-derived transcript text with the published scrub before egress, because artifacts
 * leave the trust boundary and are written to be published.
 */
import type { Deps, DocArtifact, FsGlob, RequirementBundle, Result, UsablConfig } from '../contracts/index.js';
import { parseDocsManifest } from '../coverage/docs-manifest.js';
import { generateAltTextManifest, generatePageAltTextManifest } from '../docs/alt-text-manifest.js';
import { generateAnnouncementSnippets } from '../docs/announcement-snippets.js';
import { markStale, reportSourceTree } from '../docs/evidence-binding.js';
import { generateKeyboardPaths } from '../docs/keyboard-paths.js';
import { run } from '../run.js';
import { scrubPublishedResult } from './scrub.js';

/** The trees a report is made from and listed against. */
export interface DocsTrees {
  // The tree read when the docs run started. The report records it when the run minted no
  // receipt. When the run minted one bound to another tree, a file changed during the run and the
  // report is marked stale.
  sourceTree?: string;
  // The tree the report is listed against. When given, each artifact made from another tree is
  // marked stale. Null means usabl could not read it, which also marks the report stale.
  currentTree?: string | null;
}

/**
 * Builds the full set of doc artifacts for a run.
 * Transcript-derived artifacts come from every scanned screen; the alt-text manifest is emitted
 * once per distinct content-requirement surface, sorted for stable output. A scanned screen that no
 * content requirement covers, and whose images the scan read, gets a manifest drafted from the
 * page instead, also sorted. Drafted entries are marked as such and never carry evidence.
 *
 * Every artifact records the tree it was made from: the receipt's tree when the run minted one,
 * otherwise `options.sourceTree`, the tree the caller read when the run started. When both are
 * known and differ, the artifact also records the start tree and reads as stale against any tree.
 */
export function collectDocArtifacts(
  result: Result,
  bundle: RequirementBundle,
  options: DocsTrees = {},
): DocArtifact[] {
  // Scrub first: the transcript generators strip control bytes but not credential-shaped values,
  // and this surface is egress for page-derived text. A docs report is written to be published,
  // so it takes the published scrub, which also drops the query and the fragment of every URL the
  // page repeats, as the CLI, the JSON Result, and the pull request comment do.
  const safe = scrubPublishedResult(result);

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

  const startTree = options.sourceTree ?? null;
  const sourceTree = reportSourceTree(safe, startTree);
  // The receipt reads its tree after the scan. When that differs from the tree read before the
  // run, a file changed while the run scanned, so the start tree is kept and the report is stale.
  const moved = sourceTree !== null && startTree !== null && startTree !== sourceTree ? { startTree } : {};
  const recorded =
    sourceTree === null ? artifacts : artifacts.map((artifact) => ({ ...artifact, sourceTree, ...moved }));
  return options.currentTree === undefined ? recorded : markStale(recorded, options.currentTree);
}

/**
 * Reads a saved report against the current tree: each artifact made from another tree, or that
 * records no tree, comes back marked stale with the reason and what to run. Use it wherever a
 * report written earlier is read again, so a report for old code never reads as current.
 */
export function markStaleDocArtifacts(artifacts: readonly DocArtifact[], currentTree: string): DocArtifact[] {
  return markStale(artifacts, currentTree);
}

/**
 * Projects doc artifacts into a stdout-ready JSON envelope alongside the raw artifact list.
 * With `options.currentTree`, artifacts made from another tree are marked stale in both.
 */
export function projectDocs(
  result: Result,
  bundle: RequirementBundle,
  options: DocsTrees = {},
): { json: string; artifacts: DocArtifact[] } {
  const artifacts = collectDocArtifacts(result, bundle, options);
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
  // The tree is read before the run and again after it. A file saved while the run was scanning
  // leaves the report describing code that is already gone, so the report is marked stale as soon
  // as it is printed. With no receipt, the report records the tree read before, which differs from
  // the tree read after. With a receipt, whose tree is read after the scan, the report records
  // both the receipt's tree and the tree read before, and two different trees mark it stale.
  const sourceTree = await readTree(deps);
  const result = opts.all
    ? await run(deps, config, { changedFiles: await wholeAppFiles(deps.fs, config) })
    : await run(deps, config);
  const currentTree = await readTree(deps);
  return projectDocs(result, deps.requirements, {
    ...(sourceTree === null ? {} : { sourceTree }),
    currentTree,
  });
}

// The working tree as a git tree id, the way the receipt records it, or null when git cannot say.
async function readTree(deps: Deps): Promise<string | null> {
  try {
    return await deps.git.writeTree();
  } catch {
    return null;
  }
}
