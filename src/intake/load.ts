/**
 * Requirement bundle loader for guarded YAML intake directories.
 * This unit reads and validates authored files into one normalized bundle.
 * It must fail closed on any malformed file because policy cannot be half-applied.
 */
import type { FsGlob, RequirementBundle, UsablConfig } from '../contracts/index.js';
import { normalize } from './normalize.js';
import type { ParseBundleResult } from './schema.js';

export type LoadRequirementsResult = ParseBundleResult & { path?: string };

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/g, '');
  return stripped.length === 0 ? path : stripped;
}

function pathFailure(path: string, reason: string): LoadRequirementsResult {
  return {
    ok: false,
    verdict: 'approval_required',
    path,
    reason: `requirement file ${path}: ${reason}`,
  };
}

export async function loadRequirements(fs: FsGlob, config: UsablConfig): Promise<LoadRequirementsResult> {
  if (config.requirements === undefined) {
    return {
      ok: true,
      bundle: { version: 1, requirements: [] },
    };
  }

  const root = stripTrailingSlashes(config.requirements);
  const paths = (await fs.glob([`${root}/**/*.yaml`, `${root}/**/*.yml`])).sort();
  const requirements: RequirementBundle['requirements'] = [];

  for (const path of paths) {
    const raw = await fs.readFile(path);
    if (raw === null) {
      return pathFailure(path, 'file was missing when read');
    }

    const normalized = normalize(raw);
    if (!normalized.ok) {
      // Intake is policy input. A single bad file means the full set is untrusted.
      return pathFailure(path, normalized.reason);
    }

    requirements.push(...normalized.bundle.requirements);
  }

  return {
    ok: true,
    bundle: {
      version: 1,
      requirements,
    },
  };
}
