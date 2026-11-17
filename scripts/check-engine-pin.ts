// Runs the engine pin rules from scripts/engine-pin.ts and exits 1 with one plain line when the gate
// at the head commit does not pin the engine to a commit on main, moves the pin back from the base
// commit's pin, or is not the draft that the pinned commit writes. CI's engine-pin job runs it from
// the trusted commit, in a checkout with the full history of main and the head commit fetched. The
// head's gate is read through git as data; no file of the head is run or loaded.
//
// Usage: vite-node scripts/check-engine-pin.ts --main <ref> --head <commit> [--base <commit>]
// Defaults: --main origin/main, --head HEAD, no base.
import { draftGateAtPin } from './engine-pin-draft.js';
import { COMMIT_ID, GATE_WORKFLOW, enginePinProblem, gateDraftProblem, gitIsAncestor, readEnginePin, readGitFile } from './engine-pin.js';

function fail(line: string): never {
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const mainRef = option('--main') ?? 'origin/main';
const head = option('--head') ?? 'HEAD';
const base = option('--base');
if (head !== 'HEAD' && !COMMIT_ID.test(head)) fail('usabl engine pin: --head must be a full lowercase commit id.');
if (base !== undefined && !COMMIT_ID.test(base)) fail('usabl engine pin: --base must be a full lowercase commit id.');

const headGate = readGitFile(head, GATE_WORKFLOW);
if (headGate === null) fail(`usabl engine pin: git could not read ${GATE_WORKFLOW} at the head commit, so there is no engine pin to check.`);
const baseGate = base === undefined ? null : readGitFile(base, GATE_WORKFLOW);
if (base !== undefined && baseGate === null) {
  fail(`usabl engine pin: git could not read ${GATE_WORKFLOW} at the base commit, so the check cannot tell that the pin did not move back.`);
}

const problem = enginePinProblem({ headGate, baseGate, mainRef, isAncestor: (older, newer) => gitIsAncestor(older, newer) });
if (problem !== null) fail(problem);

// The pin is a commit on main now, so its own installer may run to build the draft.
const pin = readEnginePin(headGate);
if ('problem' in pin) fail(pin.problem);
let draft: string;
try {
  draft = await draftGateAtPin(pin.sha);
} catch (error) {
  fail(error instanceof Error ? error.message : 'usabl engine pin: the draft at the pinned commit could not be built.');
}
const drift = gateDraftProblem(headGate, draft, pin.sha);
if (drift !== null) fail(drift);

process.stdout.write(
  `usabl engine pin: ${GATE_WORKFLOW} pins the engine to ${pin.sha}, a commit on ${mainRef}${base === undefined ? '' : ' that does not move back from the base pin'}, and is the draft that commit writes.\n`,
);
