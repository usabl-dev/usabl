// The rule for this repository's own engine pin. The gate in .github/workflows/usabl-gate.yml checks
// out usabl-dev/usabl at one fixed commit, so a pull request never chooses the engine that judges
// it. That commit must be one main has held: a pin to a commit main never held would let the self
// gate run engine code that no merge put on main. CI runs scripts/check-engine-pin.ts, which reads
// the pin here and asks git whether it is an ancestor of the main branch.
// This file holds the rule; scripts/check-engine-pin.ts runs it.
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

export const GATE_WORKFLOW = '.github/workflows/usabl-gate.yml';
export const ENGINE_REPOSITORY = 'usabl-dev/usabl';
const PLACEHOLDER = 'PIN_TO_A_TRUSTED_USABL_COMMIT';
const PREFIX = 'usabl engine pin:';
const REGENERATE = 'Build usabl from a clean checkout of a main commit, run usabl install --ci there, and copy the gate in.';

export type Ancestry = 'on-main' | 'not-on-main' | 'unreadable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The engine pin the gate holds, or the one line that says why it has none. Every step in every job
 * that checks out the engine repository counts, so a second engine checkout cannot hide behind the
 * first. The value is never echoed, because the workflow text is the pull request's.
 */
export function readEnginePin(raw: string): { sha: string } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch {
    return { problem: `${PREFIX} ${GATE_WORKFLOW} is not YAML that can be read.` };
  }
  const jobs = isRecord(parsed) ? parsed['jobs'] : undefined;
  if (!isRecord(jobs)) {
    return { problem: `${PREFIX} ${GATE_WORKFLOW} has no jobs, so it holds no engine pin.` };
  }
  const refs: unknown[] = [];
  for (const job of Object.values(jobs)) {
    const steps = isRecord(job) ? job['steps'] : undefined;
    for (const step of Array.isArray(steps) ? steps : []) {
      const inputs = isRecord(step) ? step['with'] : undefined;
      if (isRecord(inputs) && inputs['repository'] === ENGINE_REPOSITORY) {
        refs.push(inputs['ref']);
      }
    }
  }
  if (refs.length !== 1) {
    return {
      problem:
        refs.length === 0
          ? `${PREFIX} ${GATE_WORKFLOW} has no step that checks out ${ENGINE_REPOSITORY}, so it holds no engine pin.`
          : `${PREFIX} ${GATE_WORKFLOW} has ${refs.length} steps that check out ${ENGINE_REPOSITORY}. The gate must hold exactly one engine pin.`,
    };
  }
  const ref = refs[0];
  if (ref === PLACEHOLDER) {
    return { problem: `${PREFIX} ${GATE_WORKFLOW} still holds the placeholder ${PLACEHOLDER}, so its usabl-engine job cannot check out an engine. ${REGENERATE}` };
  }
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/.test(ref)) {
    return { problem: `${PREFIX} the engine ref in ${GATE_WORKFLOW} is not a full 40-character lowercase commit SHA. ${REGENERATE}` };
  }
  return { sha: ref };
}

/** Null when the pin is a commit on `mainRef`, otherwise the one line that says why not. */
export function enginePinProblem(raw: string, ancestry: (sha: string) => Ancestry, mainRef: string): string | null {
  const pin = readEnginePin(raw);
  if ('problem' in pin) return pin.problem;
  const answer = ancestry(pin.sha);
  if (answer === 'on-main') return null;
  if (answer === 'not-on-main') {
    return `${PREFIX} the gate pins the engine to ${pin.sha}, which is not a commit on ${mainRef}. The pin may move only to a commit on main. ${REGENERATE}`;
  }
  return `${PREFIX} git could not tell whether ${pin.sha} is a commit on ${mainRef}, because the commit or the branch is not in this checkout. Fetch the full history of main and run the check again.`;
}

/**
 * Whether `sha` is an ancestor of `mainRef`, from `git merge-base --is-ancestor`. Exit 0 is yes and
 * exit 1 is no. Any other exit, such as a commit or a branch git does not have, is unreadable,
 * never a yes.
 */
export function gitAncestry(sha: string, mainRef: string, cwd = '.'): Ancestry {
  const result = spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', '--end-of-options', sha, mainRef], { encoding: 'utf8' });
  if (result.status === 0) return 'on-main';
  if (result.status === 1) return 'not-on-main';
  return 'unreadable';
}
