/**
 * The required aggregate is the one check an operator makes required, and REQUIRED_GATE_SCRIPT
 * is the one place its pass/fail rule exists. Both generated gate workflows embed these exact
 * bytes, so these tests run the script itself rather than a restatement of it.
 *
 * The rule checks the shape of every gate job for the event, and the judge's verdict. On
 * pull_request all five jobs run and must succeed. On pull_request_review the untrusted build and
 * the comment are fenced off and must be skipped, while the engine, the judge, and the policy job
 * run again and must succeed. The verdict is the judge's job output, and only "pass" passes.
 */
import { spawnSync } from 'node:child_process';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REQUIRED_GATE_JOB, REQUIRED_GATE_SCRIPT } from '../../src/install/ci.js';

// Each spawned case starts a real node process, which is slow enough on a busy machine that
// the 5s default trips on the multi-case tests. The rule itself is instant.
const SPAWN_TIMEOUT_MS = 60_000;

interface GateInput {
  event: string;
  engine: string;
  build: string;
  scan: string;
  comment: string;
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
    ENGINE_RESULT: input.engine,
    BUILD_RESULT: input.build,
    SCAN_RESULT: input.scan,
    COMMENT_RESULT: input.comment,
    POLICY_RESULT: input.policy,
    ACCESSIBILITY_VERDICT: input.accessibility,
  };
}

// Run the exact bytes the workflow runs, in a real node process.
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

// The same bytes, evaluated in-process, so the exhaustive sweep below can cover the whole input
// space without thousands of process spawns. The script is compiled once as a function body, with
// process and console passed in, so each case is a plain call. It is held to the spawned runner by
// an agreement test, so it can never quietly diverge.
const compiled = runInThisContext(`(function (process, console) {\n${REQUIRED_GATE_SCRIPT}\n})`) as (
  process: unknown,
  console: unknown,
) => void;

function runGateInProcess(input: GateInput): GateOutcome {
  const lines: string[] = [];
  const exited = Symbol('exited');
  let code = 0;
  const record = (message: unknown): void => {
    lines.push(String(message));
  };
  try {
    compiled(
      {
        env: gateEnv(input),
        exit: (status?: number): never => {
          code = status ?? 0;
          throw exited;
        },
      },
      { log: record, error: record },
    );
  } catch (err) {
    if (err !== exited) {
      throw err;
    }
  }
  return { code, output: lines.join('\n') };
}

const CLEAN_PULL_REQUEST: GateInput = {
  event: 'pull_request',
  engine: 'success',
  build: 'success',
  scan: 'success',
  comment: 'success',
  policy: 'success',
  accessibility: 'pass',
};

const CLEAN_REVIEW: GateInput = {
  event: 'pull_request_review',
  engine: 'success',
  build: 'skipped',
  scan: 'success',
  comment: 'skipped',
  policy: 'success',
  accessibility: 'pass',
};

describe('the required aggregate job name', () => {
  it('is stable, because every consumer names it in their ruleset', () => {
    expect(REQUIRED_GATE_JOB).toBe('usabl-required');
  });
});

describe('REQUIRED_GATE_SCRIPT on a pull_request event', () => {
  it('passes when every job succeeded and the judge verdict is a pass', () => {
    expect(runGate(CLEAN_PULL_REQUEST).code).toBe(0);
  });

  it('fails when the judge reports a regression', () => {
    const outcome = runGate({ ...CLEAN_PULL_REQUEST, scan: 'failure', accessibility: 'fail' });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain('accessibility');
  });

  it('fails when the build failed, even with a clean verdict', () => {
    const outcome = runGate({ ...CLEAN_PULL_REQUEST, build: 'failure' });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain('build-app');
  });

  it('fails closed when the judge was cancelled or skipped', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, scan: 'cancelled' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, scan: 'skipped' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('fails when the engine job did not succeed', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, engine: 'failure' }).code).toBe(1);
  });

  it('fails when the comment job did not succeed', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, comment: 'failure' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, comment: 'skipped' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe('REQUIRED_GATE_SCRIPT on a pull_request_review event', () => {
  it('passes on a review where the build and comment were fenced off and the judge re-judged clean', () => {
    expect(runGate(CLEAN_REVIEW).code).toBe(0);
  });

  it('fails when the re-judged verdict is a regression', () => {
    const outcome = runGate({ ...CLEAN_REVIEW, accessibility: 'fail' });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain('accessibility');
  });

  it('fails closed when the verdict never arrived', () => {
    expect(runGate({ ...CLEAN_REVIEW, accessibility: '' }).code).toBe(1);
  });

  it('fails closed on any verdict value that is not exactly "pass"', () => {
    for (const verdict of ['PASS', 'Pass', 'true', 'ok', 'passed', '0', 'unknown']) {
      expect(runGate({ ...CLEAN_REVIEW, accessibility: verdict }).code).toBe(1);
    }
  }, SPAWN_TIMEOUT_MS);

  it('fails closed when the build ran on a review, because the fence did not hold', () => {
    expect(runGate({ ...CLEAN_REVIEW, build: 'success' }).code).toBe(1);
  });

  it('fails closed when the judge did not re-judge on the review', () => {
    expect(runGate({ ...CLEAN_REVIEW, scan: 'skipped' }).code).toBe(1);
    expect(runGate({ ...CLEAN_REVIEW, scan: 'cancelled' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe('REQUIRED_GATE_SCRIPT and the policy verdict', () => {
  it('fails when the policy job failed, on either event, even with a clean verdict', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, policy: 'failure' }).code).toBe(1);
    expect(runGate({ ...CLEAN_REVIEW, policy: 'failure' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('fails closed when the policy job was cancelled, skipped, or never reported', () => {
    for (const policy of ['cancelled', 'skipped', '']) {
      expect(runGate({ ...CLEAN_PULL_REQUEST, policy }).code).toBe(1);
      expect(runGate({ ...CLEAN_REVIEW, policy }).code).toBe(1);
    }
  }, SPAWN_TIMEOUT_MS);
});

describe('REQUIRED_GATE_SCRIPT on an unexpected event', () => {
  it('fails closed rather than assuming a shape it was not designed for', () => {
    // merge_group is not supported: a merge queue run would block here, never pass.
    for (const event of ['push', 'workflow_dispatch', 'merge_group', '']) {
      expect(runGate({ ...CLEAN_PULL_REQUEST, event }).code).toBe(1);
    }
  }, SPAWN_TIMEOUT_MS);

  it('cannot be fooled by an event name that is an object property', () => {
    expect(runGate({ ...CLEAN_PULL_REQUEST, event: 'constructor' }).code).toBe(1);
    expect(runGate({ ...CLEAN_PULL_REQUEST, event: '__proto__' }).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe('REQUIRED_GATE_SCRIPT exhaustively', () => {
  it('agrees with the spawned node process it stands in for', () => {
    const samples: GateInput[] = [
      CLEAN_PULL_REQUEST,
      CLEAN_REVIEW,
      { ...CLEAN_PULL_REQUEST, scan: 'cancelled' },
      { ...CLEAN_PULL_REQUEST, build: 'failure' },
      { ...CLEAN_REVIEW, accessibility: 'fail' },
      { ...CLEAN_REVIEW, comment: 'success' },
      { ...CLEAN_PULL_REQUEST, policy: 'skipped' },
      { ...CLEAN_PULL_REQUEST, event: 'push' },
    ];
    for (const sample of samples) {
      expect(runGateInProcess(sample).code).toBe(runGate(sample).code);
    }
  }, SPAWN_TIMEOUT_MS);

  it('passes on exactly two of the enumerated states and blocks every other one', () => {
    // Every event, every result for each of the five jobs, every verdict. Only the two clean
    // shapes may pass. Everything else, including every combination nobody named, must block.
    const events = ['pull_request', 'pull_request_review', 'push', ''];
    const results = ['success', 'failure', 'cancelled', 'skipped', ''];
    const verdicts = ['pass', 'fail', ''];
    const passing: string[] = [];
    for (const event of events) {
      for (const engine of results) {
        for (const build of results) {
          for (const scan of results) {
            for (const comment of results) {
              for (const policy of results) {
                for (const accessibility of verdicts) {
                  const input = { event, engine, build, scan, comment, policy, accessibility };
                  if (runGateInProcess(input).code === 0) {
                    passing.push(Object.values(input).join('/'));
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(passing).toEqual([
      'pull_request/success/success/success/success/success/pass',
      'pull_request_review/success/skipped/success/skipped/success/pass',
    ]);
  }, 60_000);
});
