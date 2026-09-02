/**
 * The required aggregate is the one check an operator makes required, and REQUIRED_GATE_SCRIPT
 * is the one place its pass/fail rule exists. Every generated gate workflow embeds these exact
 * bytes, so these tests run the script itself rather than a restatement of it. If the rule and
 * the workflow could drift, a merge could be allowed on a rule nobody tested.
 *
 * The hard case is the event split. The scan job runs PR head code and is fenced to the
 * pull_request event, so on a pull_request_review re-run it never runs and reports "skipped".
 * A rule that demanded scan success would break every approval-driven re-run; a rule that
 * accepted anything short of failure would pass on "cancelled" and on a scan that never ran.
 * The rule below uses the scan job result only as an event-shape check and takes the
 * accessibility verdict from the Result artifact, which the policy job resolves on both events.
 */
import { spawnSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REQUIRED_GATE_JOB, REQUIRED_GATE_SCRIPT } from '../../src/install/ci.js';

// Each spawned case starts a real node process, which is slow enough on a busy machine that
// the 5s default trips on the multi-case tests. The rule itself is instant; only the process
// start is not, so raise the ceiling rather than trade away running the real thing.
const SPAWN_TIMEOUT_MS = 60_000;

interface GateInput {
  event: string;
  scan: string;
  policy: string;
  accessibility: string;
}

interface GateOutcome {
  code: number;
  output: string;
}

function gateEnv(input: GateInput): Record<string, string> {
  return {
    EVENT_NAME: input.event,
    SCAN_RESULT: input.scan,
    POLICY_RESULT: input.policy,
    ACCESSIBILITY_VERDICT: input.accessibility,
  };
}

// Run the exact bytes the workflow runs, in a real node process, exactly as the workflow
// step does. A hand-written copy of the rule in this file would be a second decision path,
// which is the failure mode this whole gate exists to prevent.
function runGate(input: GateInput): GateOutcome {
  const outcome = spawnSync(process.execPath, ['-e', REQUIRED_GATE_SCRIPT], {
    env: gateEnv(input),
    encoding: 'utf8',
  });
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return { code: outcome.status ?? 1, output: `${outcome.stdout}${outcome.stderr}` };
}

// The same bytes, evaluated in-process. This exists only so the exhaustive sweep below can
// cover the whole input space without paying for hundreds of process spawns. It is held to
// the spawned runner by an explicit agreement test, so it can never quietly diverge.
function runGateInProcess(input: GateInput): GateOutcome {
  const lines: string[] = [];
  const exited = Symbol('exited');
  let code = 0;
  const record = (message: unknown): void => {
    lines.push(String(message));
  };
  const sandbox = {
    process: {
      env: gateEnv(input),
      exit: (status?: number): never => {
        code = status ?? 0;
        throw exited;
      },
    },
    console: { log: record, error: record },
  };
  try {
    runInContext(REQUIRED_GATE_SCRIPT, createContext(sandbox));
  } catch (err) {
    if (err !== exited) {
      throw err;
    }
  }
  return { code, output: lines.join('\n') };
}

const CLEAN_PULL_REQUEST: GateInput = {
  event: 'pull_request',
  scan: 'success',
  policy: 'success',
  accessibility: 'pass',
};

const CLEAN_REVIEW: GateInput = {
  event: 'pull_request_review',
  scan: 'skipped',
  policy: 'success',
  accessibility: 'pass',
};

describe('the required aggregate job name', () => {
  it('is stable, because every consumer names it in their ruleset', () => {
    // Changing this string forces every consuming repository to edit branch protection by
    // hand. It is pinned here so a rename cannot land as a quiet side effect.
    expect(REQUIRED_GATE_JOB).toBe('usabl-required');
  });
});

describe('REQUIRED_GATE_SCRIPT on a pull_request event', () => {
  it('passes when the scan succeeded, policy succeeded, and the artifact verdict is a pass', () => {
    const outcome = runGate(CLEAN_PULL_REQUEST);
    expect(outcome.code).toBe(0);
  });

  it('fails when the accessibility verdict is a regression, even with a green policy job', () => {
    // The regression case. The artifact verdict is the accessibility authority, so a failing
    // verdict blocks on its own.
    const outcome = runGate({ ...CLEAN_PULL_REQUEST, scan: 'failure', accessibility: 'fail' });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain('accessibility');
  });

  it('fails when the scan job failed even if the artifact verdict reads clean', () => {
    // A scan job that ran head code and then failed is not a source usabl can trust for a
    // clean verdict. On the one event where the scan does run, its success is required.
    const outcome = runGate({ ...CLEAN_PULL_REQUEST, scan: 'failure' });
    expect(outcome.code).toBe(1);
  });

  it('fails closed when the scan was cancelled', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, scan: 'cancelled' }).code).toBe(1);
  });

  it('fails closed when the scan was skipped on the event that must run it', () => {
    // gate-comment is fenced to this event, so a skip here means the fence changed shape.
    expect(runGate({ ...CLEAN_PULL_REQUEST, scan: 'skipped' }).code).toBe(1);
  });
});

describe('REQUIRED_GATE_SCRIPT on a pull_request_review event', () => {
  it('passes on an approval re-run where the scan was correctly skipped and the artifact is clean', () => {
    // The case a naive aggregate breaks. The scan cannot run on a review event because it
    // would hand base-repo secrets to head code, so "skipped" is the correct shape here and
    // must not fail the gate. The verdict comes from the artifact instead.
    const outcome = runGate(CLEAN_REVIEW);
    expect(outcome.code).toBe(0);
  });

  it('fails when the artifact-derived accessibility verdict is a regression', () => {
    // The hole this gate closes. On a review re-run the scan job is skipped, so nothing in
    // the job graph is red, yet the head still carries an accessibility regression.
    const outcome = runGate({ ...CLEAN_REVIEW, accessibility: 'fail' });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain('accessibility');
  });

  it('fails closed when the accessibility verdict never arrived', () => {
    // A missing or unparseable artifact leaves the policy job with no verdict to publish,
    // so the output is empty. Empty is a fail, never a pass.
    expect(runGate({ ...CLEAN_REVIEW, accessibility: '' }).code).toBe(1);
  });

  it('fails closed on any verdict value that is not exactly "pass"', () => {
    for (const verdict of ['PASS', 'Pass', 'true', 'ok', 'passed', '0', 'unknown']) {
      expect(runGate({ ...CLEAN_REVIEW, accessibility: verdict }).code).toBe(1);
    }
  }, SPAWN_TIMEOUT_MS);

  it('fails closed when the scan was cancelled rather than skipped', () => {
    expect(runGate({ ...CLEAN_REVIEW, scan: 'cancelled' }).code).toBe(1);
  });

  it('fails closed when the scan actually ran on a review event', () => {
    // The scan running on a review event means head code saw base-repo secrets. That is a
    // breach of the fence, so it blocks rather than counts as extra assurance.
    expect(runGate({ ...CLEAN_REVIEW, scan: 'success' }).code).toBe(1);
  });
});

describe('REQUIRED_GATE_SCRIPT and the policy verdict', () => {
  it('fails when the policy job failed, on either event, even with a clean accessibility verdict', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, policy: 'failure' }).code).toBe(1);
    expect(runGate({ ...CLEAN_REVIEW, policy: 'failure' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('fails closed when the policy job was cancelled or skipped', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, policy: 'cancelled' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, policy: 'skipped' }).code).toBe(1);
    expect(runGate({ ...CLEAN_REVIEW, policy: 'cancelled' }).code).toBe(1);
    expect(runGate({ ...CLEAN_REVIEW, policy: 'skipped' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('fails closed when the policy job result never arrived', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, policy: '' }).code).toBe(1);
  });
});

describe('REQUIRED_GATE_SCRIPT on an unexpected event', () => {
  it('fails closed rather than assuming a shape it was not designed for', () => {
    // Adding a trigger to the workflow must not silently open the gate. An event this rule
    // does not know cannot be reasoned about, so it blocks and says so.
    expect(runGate({ ...CLEAN_PULL_REQUEST, event: 'push' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, event: 'workflow_dispatch' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, event: '' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe('REQUIRED_GATE_SCRIPT exhaustively', () => {
  it('agrees with the spawned node process it stands in for', () => {
    // Validate the in-process runner against the real one before trusting the sweep below.
    const samples: GateInput[] = [
      CLEAN_PULL_REQUEST,
      CLEAN_REVIEW,
      { ...CLEAN_PULL_REQUEST, scan: 'cancelled' },
      { ...CLEAN_REVIEW, accessibility: 'fail' },
      { ...CLEAN_REVIEW, accessibility: '' },
      { ...CLEAN_PULL_REQUEST, policy: 'skipped' },
      { ...CLEAN_PULL_REQUEST, event: 'push' },
    ];
    for (const sample of samples) {
      expect(runGateInProcess(sample).code).toBe(runGate(sample).code);
    }
  }, SPAWN_TIMEOUT_MS);

  it('passes on exactly two of the enumerated states and blocks every other one', () => {
    // Enumerate the whole space rather than trusting the named cases above to be complete.
    // Only the two clean shapes may pass. Everything else, including every combination that
    // nobody thought to name, must block.
    const events = ['pull_request', 'pull_request_review', 'push', ''];
    const results = ['success', 'failure', 'cancelled', 'skipped', ''];
    const verdicts = ['pass', 'fail', ''];
    const passing: string[] = [];
    for (const event of events) {
      for (const scan of results) {
        for (const policy of results) {
          for (const accessibility of verdicts) {
            if (runGateInProcess({ event, scan, policy, accessibility }).code === 0) {
              passing.push(`${event}/${scan}/${policy}/${accessibility}`);
            }
          }
        }
      }
    }
    expect(passing).toEqual([
      'pull_request/success/success/pass',
      'pull_request_review/skipped/success/pass',
    ]);
  });
});
