/**
 * Design requirements whose surface matches no screen usabl knows.
 *
 * A content or flow requirement is checked by a provider that runs only on a screen whose id is
 * the requirement's surface. A surface that matches no configured, routed, or documented screen is
 * never planned, so its requirement is never checked. Saying nothing about it would let a
 * misspelled surface turn a requirement off while the run still reads as verified. Each one is a
 * not-covered gap that names the requirement and the surface.
 *
 * A requirement on a known screen that a run did not plan is out of scope for that run, not a gap:
 * the screen is checked on the runs that touch it. Doc requirements are not runtime checks, so
 * they never produce a gap here.
 *
 * The CLI run and checkPage both use this, so the two cannot disagree about which requirements
 * nothing checked.
 */
import type { CoverageGap, FsGlob, RequirementBundle, UsablConfig } from '../contracts/index.js';
import { parseRouteManifest } from '../coverage/route-manifest.js';
import { scrubString } from '../surfaces/scrub.js';

/** The gaps for each runtime requirement whose surface is not in `knownSurfaceIds`, in bundle order. */
export function unknownSurfaceRequirementGaps(
  requirements: RequirementBundle,
  knownSurfaceIds: ReadonlySet<string>,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const requirement of requirements.requirements) {
    if (requirement.assertion.type !== 'content' && requirement.assertion.type !== 'flow') {
      continue;
    }
    if (knownSurfaceIds.has(requirement.surface)) {
      continue;
    }
    gaps.push({
      ref: `requirement:${requirement.id}`,
      state: 'not-covered',
      reason: scrubString(
        `requirement ${requirement.id} names surface ${requirement.surface}, which matches no configured or discovered surface, so it was not checked`,
      ),
    });
  }
  return gaps;
}

/**
 * The surface ids a project names: its configured surfaces and the screens of its route manifest.
 * An unreadable route manifest names no extra surfaces. That can only turn a requirement into a
 * gap, never let one through unchecked.
 */
export async function knownSurfaceIds(fs: FsGlob, config: UsablConfig): Promise<Set<string>> {
  const known = new Set(config.surfaces.map((surface) => surface.id));
  try {
    for (const route of (await parseRouteManifest(fs, config.discovery)).routes) {
      known.add(route.screenId);
    }
  } catch {
    // See the function comment.
  }
  return known;
}

/**
 * The gaps for a CLI run: each runtime requirement whose surface matches no configured surface,
 * no route manifest screen, and no docs manifest page. Read through the same file view the run
 * planned coverage with, so a branch cannot add a surface to the manifests to hide a gap.
 */
export async function unknownSurfaceGapsForRun(
  requirements: RequirementBundle,
  fs: FsGlob,
  config: UsablConfig,
  docsPageIds: readonly string[],
): Promise<CoverageGap[]> {
  const known = await knownSurfaceIds(fs, config);
  for (const pageId of docsPageIds) {
    known.add(pageId);
  }
  return unknownSurfaceRequirementGaps(requirements, known);
}
