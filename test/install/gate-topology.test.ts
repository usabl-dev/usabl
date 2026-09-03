/**
 * Gate topology: which check an operator makes required, and whether that check can be
 * green while accessibility is red.
 *
 * Before the aggregate existed, accessibility was enforced only inside gate-comment, which
 * was not a required check, while the required usabl-policy job returned success whenever no
 * guarded path diverged. A red scan and a green policy therefore satisfied the ruleset. These
 * tests hold the shape that closes that: one required job that sees both verdicts, present in
 * every workflow usabl generates and in the one this repository runs on itself.
 *
 * All three workflows are asserted together on purpose. A fix that landed in the generated
 * drafts but not in the checked-in gate, or in the app gate but not the docs gate, would leave
 * the same hole open somewhere, so there is one list of properties and three subjects.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { parseResultJson } from '../../src/surfaces/policy-enforce.js';
import {
  REQUIRED_GATE_JOB,
  REQUIRED_GATE_SCRIPT,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW,
  indentScript,
} from '../../src/install/ci.js';
import { REQUIRED_CHECK, branchRuleSetting } from '../../src/install/branch-rule.js';

const ENGINE_GATE_PATH = new URL('../../.github/workflows/usabl-gate.yml', import.meta.url);
const ENGINE_GATE_WORKFLOW = readFileSync(ENGINE_GATE_PATH, 'utf8');

// Every gate carries the same topology. The engine's own workflow builds the tree it checked
// out instead of a pinned clone, so its cli path differs, but the decision rule does not.
const WORKFLOWS: Array<{ name: string; body: string }> = [
  { name: 'the generated app gate', body: USABL_GATE_WORKFLOW },
  { name: 'the generated docs gate', body: USABL_DOCS_GATE_WORKFLOW },
  { name: 'the checked-in engine gate', body: ENGINE_GATE_WORKFLOW },
];

// Read the workflow the way GitHub does, through a real YAML parser, so the structural
// assertions rest on the parsed document rather than on substrings. String containment alone
// cannot tell a valid workflow from one GitHub would reject: a change to the block-scalar
// depth could emit unparseable YAML while every `toContain` still matched.
interface ParsedStep {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
}

interface ParsedJob {
  name?: string;
  needs?: string | string[];
  if?: string | boolean;
  outputs?: Record<string, string>;
  steps?: ParsedStep[];
}

interface ParsedWorkflow {
  jobs?: Record<string, ParsedJob>;
}

const parseCache = new Map<string, ParsedWorkflow>();

function parseWorkflow(workflow: string): ParsedWorkflow {
  const cached = parseCache.get(workflow);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = load(workflow) as ParsedWorkflow;
  parseCache.set(workflow, parsed);
  return parsed;
}

function parsedJob(workflow: string, job: string): ParsedJob {
  const found = parseWorkflow(workflow).jobs?.[job];
  if (found === undefined) {
    throw new Error(`parsed workflow has no ${job} job`);
  }
  return found;
}

function parsedStep(workflow: string, job: string, stepName: string): ParsedStep {
  const found = parsedJob(workflow, job).steps?.find((step) => step.name === stepName);
  if (found === undefined) {
    throw new Error(`parsed job ${job} has no step named ${stepName}`);
  }
  return found;
}

// Slice a job out of the workflow so a property can be asserted about that job alone. It
// throws on a missing job rather than returning an empty string, because an assertion against
// an empty slice would pass while proving nothing.
function jobBody(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start === -1) {
    throw new Error(`workflow has no ${job} job`);
  }
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

// Pull a step's `run: |` body out of the workflow and undo the block-scalar indent, so a test
// can execute the exact shell GitHub would execute. Asserting on the YAML text alone would
// miss a broken heredoc or a mis-indented block, which is the kind of mistake that turns a
// required check green by accident.
const RUN_INDENT = '          ';

function runBodyAfter(workflow: string, anchor: string): string {
  const anchorAt = workflow.indexOf(anchor);
  if (anchorAt === -1) {
    throw new Error(`workflow has no step matching ${anchor}`);
  }
  const rest = workflow.slice(anchorAt);
  const runAt = rest.indexOf('        run: |\n');
  if (runAt === -1) {
    throw new Error(`step ${anchor} has no run block`);
  }
  const lines = rest.slice(runAt + '        run: |\n'.length).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (line !== '' && !line.startsWith(RUN_INDENT)) {
      break;
    }
    body.push(line === '' ? '' : line.slice(RUN_INDENT.length));
  }
  return body.join('\n');
}

const tempDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usabl-gate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe.each(WORKFLOWS)('$name', ({ body }) => {
  describe('parsed as a real YAML document', () => {
    // Everything below reads the parsed document. If the generator ever emits YAML GitHub
    // would reject, these fail where a substring search would not notice.
    it('parses, and declares exactly the three gate jobs', () => {
      const jobs = parseWorkflow(body).jobs ?? {};
      expect(Object.keys(jobs)).toEqual(['gate-comment', 'usabl-policy', REQUIRED_GATE_JOB]);
    });

    it('gives the aggregate always() and a dependency on both other jobs', () => {
      const job = parsedJob(body, REQUIRED_GATE_JOB);
      expect(job.if).toBe('always()');
      expect(job.needs).toEqual(['gate-comment', 'usabl-policy']);
    });

    it('leaves the aggregate without a name override, so the check context is the job id', () => {
      // GitHub names the check run after the job's `name:` when there is one, and after the
      // job id otherwise. branch-rule tells operators to require the job id, so a `name:`
      // added here would silently stop the required context from matching.
      expect(parsedJob(body, REQUIRED_GATE_JOB).name).toBeUndefined();
      expect(REQUIRED_CHECK).toBe(REQUIRED_GATE_JOB);
    });

    it('passes the rule its four inputs and nothing else', () => {
      const step = parsedStep(body, REQUIRED_GATE_JOB, 'Decide the merge gate');
      expect(Object.keys(step.env ?? {})).toEqual([
        'EVENT_NAME',
        'SCAN_RESULT',
        'POLICY_RESULT',
        'ACCESSIBILITY_VERDICT',
      ]);
    });

    it('declares the accessibility job output on the policy job', () => {
      expect(parsedJob(body, 'usabl-policy').outputs).toEqual({
        accessibility: '${{ steps.accessibility.outputs.verdict }}',
      });
    });

    it('gives the verdict step the id the output expression reads', () => {
      const step = parsedStep(
        body,
        'usabl-policy',
        'Resolve the accessibility verdict from the Result artifact',
      );
      expect(step.id).toBe('accessibility');
    });

    it('reduces to exactly the heredoc-wrapped rule after the parser dedents it', () => {
      // Exact equality on the parsed value, not containment. A substring check can slide
      // past a leading-whitespace shift on the first script line and still match, so it
      // would accept a workflow whose embedded bytes are not the rule usabl generated.
      expect(parsedStep(body, REQUIRED_GATE_JOB, 'Decide the merge gate').run).toBe(
        `node <<'NODE'\n${REQUIRED_GATE_SCRIPT}\nNODE\n`,
      );
    });

    it('yields the same run bodies the text slicer hands to bash', () => {
      // The shell tests execute a body recovered by slicing text and stripping a fixed
      // indent. Pin that harness to the parser, so a change to the block-scalar depth
      // cannot leave the slicer quietly reading the wrong bytes while its tests still pass.
      expect(parsedStep(body, REQUIRED_GATE_JOB, 'Decide the merge gate').run).toBe(
        runBodyAfter(body, '      - name: Decide the merge gate\n'),
      );
      expect(
        parsedStep(body, 'usabl-policy', 'Resolve the accessibility verdict from the Result artifact')
          .run,
      ).toBe(
        runBodyAfter(
          body,
          '      - name: Resolve the accessibility verdict from the Result artifact\n',
        ),
      );
    });

    it('keeps the head-code fence on the scan job as a parsed condition', () => {
      expect(parsedJob(body, 'gate-comment').if).toBe("github.event_name == 'pull_request'");
    });
  });

  it('declares the required aggregate job', () => {
    expect(body).toContain(`\n  ${REQUIRED_GATE_JOB}:\n`);
  });

  it('makes the aggregate depend on both the scan job and the policy job', () => {
    // It must see both verdicts. Depending on only one of them recreates the hole.
    expect(body).toContain('needs: [gate-comment, usabl-policy]');
  });

  it('runs the aggregate with always(), so it can never be reported as a skipped success', () => {
    // A required check that is skipped counts as satisfied. always() is what keeps the
    // aggregate from disappearing when an upstream job fails, is skipped, or is cancelled.
    expect(jobBody(body, REQUIRED_GATE_JOB)).toContain('if: always()');
  });

  it('embeds the one decision rule verbatim', () => {
    // The rule lives in exactly one place. If a workflow carried its own copy, the tests in
    // required-gate.test.ts would be testing a rule that is not the one CI runs.
    expect(body).toContain(indentScript(REQUIRED_GATE_SCRIPT, '          '));
  });

  it('feeds the rule the two job results and the artifact-derived accessibility verdict', () => {
    expect(body).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(body).toContain('SCAN_RESULT: ${{ needs.gate-comment.result }}');
    expect(body).toContain('POLICY_RESULT: ${{ needs.usabl-policy.result }}');
    expect(body).toContain(
      'ACCESSIBILITY_VERDICT: ${{ needs.usabl-policy.outputs.accessibility }}',
    );
  });

  it('publishes the accessibility verdict as a policy job output', () => {
    // The verdict travels as data. Inferring it from a job result would be a second verdict
    // path, and on a review event there is no scan job result to infer anything from.
    expect(body).toContain('accessibility: ${{ steps.accessibility.outputs.verdict }}');
  });

  it('derives that verdict by running enforce accessibility on the Result artifact', () => {
    const policyJob = jobBody(body, 'usabl-policy');
    expect(policyJob).toContain('id: accessibility');
    expect(policyJob).toContain('enforce accessibility < usabl-result.json');
  });

  it('defaults the verdict to fail so a missing or unreadable artifact can never read as pass', () => {
    const policyJob = jobBody(body, 'usabl-policy');
    expect(policyJob).toContain('verdict=fail');
    expect(policyJob).toContain('if [ ! -s usabl-result.json ]');
  });

  it('resolves the verdict before enforcing policy, so a policy block never hides it', () => {
    const policyJob = jobBody(body, 'usabl-policy');
    const verdictAt = policyJob.indexOf('id: accessibility');
    const enforceAt = policyJob.indexOf('name: Enforce policy');
    expect(verdictAt).toBeGreaterThan(-1);
    expect(enforceAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeLessThan(enforceAt);
  });

  it('keeps the aggregate free of PR head code', () => {
    // The aggregate runs on every event, including pull_request_review, which carries
    // base-repo secrets. It reads three strings and decides. It checks nothing out.
    const aggregate = jobBody(body, REQUIRED_GATE_JOB);
    expect(aggregate).toContain('runs-on: ubuntu-latest');
    expect(aggregate).not.toContain('actions/checkout');
    expect(aggregate).not.toContain('npm ci');
  });

  it('leaves the head-code fence on the scan job untouched', () => {
    // The whole difficulty of this gate comes from this fence, so assert it survived.
    expect(body).toContain("if: github.event_name == 'pull_request'");
  });

  it('runs the embedded rule correctly as shell, not just as a matching string', () => {
    // Execute the aggregate step exactly as GitHub would: the dedented run body, through
    // bash, with the four values in the environment. This is what catches a broken heredoc
    // or a bad indent, which a text comparison would sail straight past.
    const shell = runBodyAfter(body, '      - name: Decide the merge gate\n');
    const decide = (env: Record<string, string>): number => {
      const outcome = spawnSync('bash', ['-c', shell], { env: { ...process.env, ...env } });
      return outcome.status ?? 1;
    };
    const clean = {
      EVENT_NAME: 'pull_request',
      SCAN_RESULT: 'success',
      POLICY_RESULT: 'success',
      ACCESSIBILITY_VERDICT: 'pass',
    };
    const cleanReview = {
      EVENT_NAME: 'pull_request_review',
      SCAN_RESULT: 'skipped',
      POLICY_RESULT: 'success',
      ACCESSIBILITY_VERDICT: 'pass',
    };
    expect(decide(clean)).toBe(0);
    expect(decide(cleanReview)).toBe(0);
    expect(decide({ ...cleanReview, ACCESSIBILITY_VERDICT: 'fail' })).toBe(1);
    expect(decide({ ...cleanReview, ACCESSIBILITY_VERDICT: '' })).toBe(1);
    expect(decide({ ...clean, SCAN_RESULT: 'cancelled' })).toBe(1);
    expect(decide({ ...clean, POLICY_RESULT: 'failure' })).toBe(1);
  }, 60_000);

  describe('the accessibility verdict step', () => {
    // Run the real shell of the verdict step against a stub engine, so the mapping from
    // artifact state to published verdict is exercised rather than described. The stub
    // stands in for the engine's exit code only; what the engine decides is its own
    // business and this change does not touch it.
    const shell = runBodyAfter(
      body,
      '      - name: Resolve the accessibility verdict from the Result artifact\n',
    );
    const cliPath = /node (\S*dist\/cli\.js) enforce accessibility/.exec(shell)?.[1] ?? '';

    function publishVerdict(artifact: string | null, engineExit: number): string {
      const dir = scratchDir();
      const stub = join(dir, cliPath);
      mkdirSync(dirname(stub), { recursive: true });
      writeFileSync(stub, `process.exit(${engineExit});\n`);
      if (artifact !== null) {
        writeFileSync(join(dir, 'usabl-result.json'), artifact);
      }
      const output = join(dir, 'github-output');
      writeFileSync(output, '');
      spawnSync('bash', ['-c', shell], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      const written = readFileSync(output, 'utf8');
      return /verdict=(\S*)/.exec(written)?.[1] ?? '';
    }

    it('finds the engine cli in its own run body', () => {
      expect(cliPath).toMatch(/dist\/cli\.js$/);
    });

    it('publishes pass only when the engine exits clean on a real artifact', () => {
      expect(publishVerdict('{"schemaVersion":"usabl.result.v1"}', 0)).toBe('pass');
    });

    it('publishes fail when the engine reports a regression', () => {
      expect(publishVerdict('{"schemaVersion":"usabl.result.v1"}', 1)).toBe('fail');
    });

    it('publishes fail when the artifact is unparseable', () => {
      // The engine exits 4 on input it cannot parse, and any non-zero exit is a fail here.
      expect(publishVerdict('not json at all', 4)).toBe('fail');
    });

    it('publishes fail when the artifact is missing or empty, without running the engine', () => {
      expect(publishVerdict(null, 0)).toBe('fail');
      expect(publishVerdict('', 0)).toBe('fail');
    });
  });
});

describe('the engine behind the published verdict', () => {
  it('refuses an unparseable Result, which is what makes the exit-4 path real', () => {
    // The verdict step above treats any non-zero engine exit as a fail. This is the other
    // half of that claim: the engine really does refuse input it cannot read, so a corrupt
    // or hand-edited artifact cannot come back as a pass.
    expect(() => parseResultJson('not an object')).toThrow();
    expect(() => parseResultJson({})).toThrow();
    expect(() => parseResultJson({ schemaVersion: 'usabl.result.v1' })).toThrow();
  });
});

describe('what an operator is told to require', () => {
  it('names the aggregate, not the policy job', () => {
    expect(REQUIRED_CHECK).toBe(REQUIRED_GATE_JOB);
  });

  it('prints the aggregate in the branch protection setting', () => {
    const setting = branchRuleSetting();
    expect(setting).toContain(REQUIRED_GATE_JOB);
    expect(setting).toContain(`contexts: ["${REQUIRED_GATE_JOB}"]`);
  });
});
