/**
 * Requirement bundle loader for guarded YAML intake directories.
 * This unit reads and validates authored files into one normalized bundle.
 * It must fail closed on any malformed file because policy cannot be half-applied.
 */
import type { FsGlob, RequirementBundle, UsablConfig } from '../contracts/index.js';
import { scrubString } from '../surfaces/scrub.js';
import { normalize } from './normalize.js';
import { findDuplicateRequirementId, type RequirementIdSite } from './requirement-ids.js';
import type { ParseBundleResult } from './schema.js';

export type LoadRequirementsResult = ParseBundleResult & { path?: string };

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/g, '');
  return stripped.length === 0 ? path : stripped;
}

/**
 * The one egress for a loader failure. The path is an operator-authored file name and the reason
 * can quote file bytes, for example an unrecognised key name from the schema or a source line from
 * the YAML parser, and both reach a terminal, so the whole sentence is scrubbed here. Scrubbing
 * text that a producer already scrubbed changes nothing, so a reason may arrive clean or not.
 */
function pathFailure(path: string, reason: string): LoadRequirementsResult {
  return {
    ok: false,
    verdict: 'approval_required',
    path,
    reason: scrubString(`requirements path ${path}: ${reason}`),
  };
}

function isValidRequirementsRoot(root: string): boolean {
  if (root.length === 0 || root === '.') {
    return false;
  }
  return !root.split('/').includes('..');
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export async function loadRequirements(fs: FsGlob, config: UsablConfig): Promise<LoadRequirementsResult> {
  if (config.requirements === undefined) {
    return {
      ok: true,
      bundle: { version: 1, requirements: [] },
    };
  }

  const root = stripTrailingSlashes(config.requirements);
  if (!isValidRequirementsRoot(root)) {
    // Unanchored roots can walk outside policy scope and pull YAML from the whole tree.
    return pathFailure(config.requirements, 'requirements root must be anchored and not use traversal segments');
  }

  let paths: string[];
  try {
    paths = (await fs.glob([`${root}/**/*.yaml`, `${root}/**/*.yml`])).sort();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return pathFailure(root, `failed to glob requirement files: ${message}`);
  }

  if (paths.length === 0) {
    // A configured requirements directory is required policy input, not optional.
    return pathFailure(root, 'configured requirements directory had no yaml files');
  }

  const requirements: RequirementBundle['requirements'] = [];
  // Which file each id came from. The flat bundle loses that, and the operator needs both files
  // to fix a repeat, because the two requirements are usually not in the same one.
  const idSites: RequirementIdSite[] = [];

  for (const path of paths) {
    if (!isWithinRoot(path, root)) {
      return pathFailure(path, `glob match escaped configured requirements root ${root}`);
    }

    let raw: string | null;
    try {
      raw = await fs.readFile(path);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return pathFailure(path, `failed to read requirement file: ${message}`);
    }
    if (raw === null) {
      return pathFailure(path, 'file was missing when read');
    }

    const normalized = normalize(raw);
    if (!normalized.ok) {
      // Intake is policy input. A single bad file means the full set is untrusted.
      return pathFailure(path, normalized.reason);
    }

    requirements.push(...normalized.bundle.requirements);
    normalized.bundle.requirements.forEach((requirement, index) => {
      idSites.push({ id: requirement.id, path, index });
    });
  }

  // Uniqueness is checked here, over every file at once, and not in the per-file schema.
  // A requirement id becomes the rule `intake:<id>`, and a waiver matches on that rule plus the
  // surface. Two requirements that share an id therefore share a rule, so one waiver silently
  // covers a requirement its author never saw and a real unwaived barrier reports as verified.
  // Each file on its own is valid in that case, so only the assembled bundle can see it.
  //
  // This returns a failure rather than throwing one. The dependency builder calls this loader
  // outside any try and keeps building so the run can fail closed through the gate, and the run
  // itself reads only `ok` and `path` from this result. The reason is therefore recorded here
  // but is not yet shown to the operator; surfacing it is the run's job and is not done in this
  // unit.
  const duplicate = findDuplicateRequirementId(idSites);
  if (duplicate !== null) {
    return pathFailure(duplicate.path, duplicate.reason);
  }

  return {
    ok: true,
    bundle: {
      version: 1,
      requirements,
    },
  };
}
