// The rule for this repository's own engine pin. The gate in .github/workflows/usabl-gate.yml checks
// out usabl-dev/usabl at one fixed commit, so a pull request that does not edit the workflows never
// chooses the engine that judges it. The pin must be a commit main has held, it never moves back,
// and the gate must be the draft that the pinned commit's own installer writes.
// CI's engine-pin job runs scripts/check-engine-pin.ts from the trusted commit. It reads the pull
// request's gate only as data, through git, and judges it with the rules in this file.
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

export const GATE_WORKFLOW = '.github/workflows/usabl-gate.yml';
export const ENGINE_REPOSITORY = 'usabl-dev/usabl';
const PLACEHOLDER = 'PIN_TO_A_TRUSTED_USABL_COMMIT';
const PREFIX = 'usabl engine pin:';
const REGENERATE = 'Build usabl from a clean checkout of a main commit, run usabl install --ci there, and copy the gate in.';
export const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The two checkouts of this repository the gate makes on purpose: the pull request head, as
// untrusted code or data, and the base, as trusted config. They are not engine checkouts. Any other
// checkout of this repository is counted, because on this repository it checks out the engine.
const OWN_COMMIT_REFS: readonly string[] = ['${{ github.event.pull_request.head.sha }}', '${{ github.event.pull_request.base.sha }}'];

export type Ancestry = 'ancestor' | 'not-ancestor' | 'unreadable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{');
}

// Repository names on GitHub ignore case, and a clone URL may end in .git.
function namesEngine(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().replace(/\.git$/, '') === ENGINE_REPOSITORY;
}

function isCheckout(step: Record<string, unknown>): boolean {
  const uses = step['uses'];
  return typeof uses === 'string' && /^actions\/checkout@/i.test(uses.trim());
}

/**
 * Whether a step could check out the engine. It fails closed: a step that names the engine in any
 * case, names a repository through an expression, or checks out this repository at anything but
 * the pull request's own head or base commit counts. The comparison with the draft at the pin is
 * what holds the whole gate; this rule only finds the pin and refuses a second engine checkout.
 */
function couldCheckOutEngine(step: unknown): boolean {
  if (!isRecord(step)) return false;
  const inputs = isRecord(step['with']) ? step['with'] : {};
  const repository = inputs['repository'];
  if (namesEngine(repository) || hasExpression(repository)) return true;
  if (!isCheckout(step) || repository !== undefined) return false;
  const ref = inputs['ref'];
  return !(typeof ref === 'string' && OWN_COMMIT_REFS.includes(ref));
}

/**
 * The engine pin the gate holds, or the one line that says why it has none. The pin is printed
 * only once it is a full commit id, so no text the pull request chooses reaches the log.
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
      if (couldCheckOutEngine(step)) {
        const inputs = isRecord(step) && isRecord(step['with']) ? step['with'] : {};
        refs.push(inputs['ref']);
      }
    }
  }
  if (refs.length !== 1) {
    return {
      problem:
        refs.length === 0
          ? `${PREFIX} ${GATE_WORKFLOW} has no step that can check out the engine, so it holds no engine pin.`
          : `${PREFIX} ${GATE_WORKFLOW} has ${refs.length} steps that can check out the engine. The gate must hold exactly one engine checkout.`,
    };
  }
  const ref = refs[0];
  if (ref === PLACEHOLDER) {
    return { problem: `${PREFIX} ${GATE_WORKFLOW} still holds the placeholder ${PLACEHOLDER}, so its usabl-engine job cannot check out an engine. ${REGENERATE}` };
  }
  if (typeof ref !== 'string' || !COMMIT_ID.test(ref)) {
    return { problem: `${PREFIX} the engine ref in ${GATE_WORKFLOW} is not a full lowercase commit id (40 or 64 hex characters). ${REGENERATE}` };
  }
  return { sha: ref };
}

export interface PinInput {
  // The pull request's gate, read as data.
  headGate: string;
  // The gate at the base commit, or null when there is no base to compare with, such as on a push.
  baseGate: string | null;
  mainRef: string;
  isAncestor: (older: string, newer: string) => Ancestry;
}

/**
 * Null when the pin is a commit on `mainRef` and, when a base gate is given, the base pin or a
 * commit after it. Otherwise the one line that says why not. An answer git cannot give is a
 * failure, never a pass.
 */
export function enginePinProblem(input: PinInput): string | null {
  const pin = readEnginePin(input.headGate);
  if ('problem' in pin) return pin.problem;
  const onMain = input.isAncestor(pin.sha, input.mainRef);
  if (onMain === 'not-ancestor') {
    return `${PREFIX} the gate pins the engine to ${pin.sha}, which is not a commit on ${input.mainRef}. The pin may move only to a commit on main. ${REGENERATE}`;
  }
  if (onMain !== 'ancestor') {
    return `${PREFIX} git could not tell whether ${pin.sha} is a commit on ${input.mainRef}, because a commit or the branch is not in this checkout. Fetch the full history of main and run the check again.`;
  }
  if (input.baseGate === null) return null;
  const base = readEnginePin(input.baseGate);
  if ('problem' in base) {
    return `${PREFIX} the gate at the base commit holds no engine pin usabl can read, so the check cannot tell that the pin did not move back.`;
  }
  if (base.sha === pin.sha) return null;
  const forward = input.isAncestor(base.sha, pin.sha);
  if (forward === 'not-ancestor') {
    return `${PREFIX} the gate moves the engine pin from ${base.sha} to ${pin.sha}, which does not descend from it. The pin never moves back: pin a main commit that comes after ${base.sha}.`;
  }
  if (forward !== 'ancestor') {
    return `${PREFIX} git could not tell whether ${pin.sha} comes after ${base.sha}, because a commit is not in this checkout. Fetch the full history of main and run the check again.`;
  }
  return null;
}

/** Null when the gate is the draft byte for byte, otherwise the line that names the first difference. */
export function gateDraftProblem(gate: string, draft: string, pin: string): string | null {
  if (gate === draft) return null;
  const actual = gate.split('\n');
  const expected = draft.split('\n');
  let line = 0;
  while (line < actual.length && line < expected.length && actual[line] === expected[line]) line += 1;
  return `${PREFIX} ${GATE_WORKFLOW} is not the gate usabl install --ci writes at the pinned commit ${pin}. The first difference is at line ${line + 1}. Build usabl from a clean checkout of that commit, run usabl install --ci there, and copy the gate in.`;
}

/**
 * Whether `older` is an ancestor of `newer` (or the same commit), from `git merge-base
 * --is-ancestor`. Exit 0 is yes and exit 1 is no. Any other exit, such as a commit or a branch git
 * does not have, is unreadable, never a yes.
 */
export function gitIsAncestor(older: string, newer: string, cwd = '.'): Ancestry {
  const result = spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', '--end-of-options', older, newer], { encoding: 'utf8' });
  if (result.status === 0) return 'ancestor';
  if (result.status === 1) return 'not-ancestor';
  return 'unreadable';
}

/** A file at a commit, read as data through git, or null when git cannot read it. */
export function readGitFile(commit: string, path: string, cwd = '.'): string | null {
  const result = spawnSync('git', ['-C', cwd, 'show', '--end-of-options', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}
