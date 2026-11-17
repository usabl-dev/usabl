// Runs the engine pin rule from scripts/engine-pin.ts and exits 1 with one plain line when the gate
// does not pin the engine to a commit on main. CI runs it in a checkout with the full history of
// main, so git can answer.
//
// Usage: vite-node scripts/check-engine-pin.ts [main ref]
// Default main ref: origin/main.
import { readFileSync } from 'node:fs';
import { GATE_WORKFLOW, enginePinProblem, gitAncestry } from './engine-pin.js';

const mainRef = process.argv[2] ?? 'origin/main';

let raw: string;
try {
  raw = readFileSync(GATE_WORKFLOW, 'utf8');
} catch {
  process.stderr.write(`usabl engine pin: ${GATE_WORKFLOW} could not be read, so there is no engine pin to check.\n`);
  process.exit(1);
}

const problem = enginePinProblem(raw, (sha) => gitAncestry(sha, mainRef), mainRef);
if (problem !== null) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`usabl engine pin: ${GATE_WORKFLOW} pins the engine to a commit on ${mainRef}.\n`);
