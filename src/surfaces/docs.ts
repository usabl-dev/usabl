/**
 * Docs-output projection for a gated Result plus the design-intake requirement bundle.
 * This unit assembles read-only doc artifacts; it never recomputes findings or mints a verdict.
 * It scrubs page-derived transcript text before egress because artifacts leave the trust boundary.
 */
import type { DocArtifact, RequirementBundle, Result } from '../contracts/index.js';
import { generateAltTextManifest } from '../docs/alt-text-manifest.js';
import { generateAnnouncementSnippets } from '../docs/announcement-snippets.js';
import { generateKeyboardPaths } from '../docs/keyboard-paths.js';
import { scrubResult } from './scrub.js';

/**
 * Builds the full set of doc artifacts for a run.
 * Transcript-derived artifacts come from every scanned screen; the alt-text manifest is emitted
 * once per distinct content-requirement surface, sorted for stable output.
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
