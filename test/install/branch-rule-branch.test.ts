/**
 * The branch rule check reads the branch the gate workflow on disk names, and checks the protection
 * on that branch. Every place that used to reason about main (ruleset includes and excludes,
 * ~DEFAULT_BRANCH, classic protection) reasons about that branch. With no gate workflow, or one
 * whose branch cannot be read, it checks main and says that it assumed it. When GitHub's default
 * branch is another branch, it says so in one line. An answer it cannot evaluate is never verified.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { branchRuleSetting, gateBranchTarget, REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import { gateWorkflowFor, pinEngineRef, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';
import type { InstallFs } from '../../src/install/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TRUNK = { name: 'trunk', source: 'gate' } as const;

function recordingGh(reply: (endpoint: string) => GhResult | null): { reader: GhReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      getJson: async (endpoint) => {
        calls.push(endpoint);
        return reply(endpoint);
      },
    },
  };
}

const requiredCheckRule = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: REQUIRED_CHECK }] } };
const codeOwnerRule = {
  type: 'pull_request',
  parameters: { require_code_owner_review: true, dismiss_stale_reviews_on_push: true, required_approving_review_count: 1 },
};
const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// No classic protection on any branch, one active ruleset with every rule and these conditions, and
// a repository whose default branch is `defaultBranch`.
function ghWithRuleset(defaultBranch: string, conditions: unknown): ReturnType<typeof recordingGh> {
  return recordingGh((endpoint) => {
    if (endpoint === 'repos/{owner}/{repo}') return { code: 0, stdout: JSON.stringify({ default_branch: defaultBranch }), stderr: '' };
    if (endpoint.endsWith('/rulesets/7')) {
      return {
        code: 0,
        stdout: JSON.stringify({ name: 'Protect', target: 'branch', enforcement: 'active', conditions, rules: [requiredCheckRule, codeOwnerRule] }),
        stderr: '',
      };
    }
    if (endpoint.includes('/rulesets')) return { code: 0, stdout: JSON.stringify([{ id: 7, target: 'branch', enforcement: 'active' }]), stderr: '' };
    return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
  });
}

describe('verifyBranchRule for a gate on trunk, in a repository whose default branch is trunk', () => {
  it('verifies a ruleset that includes trunk by name', async () => {
    const gh = ghWithRuleset('trunk', { ref_name: { include: ['refs/heads/trunk'], exclude: [] } });
    const result = await verifyBranchRule(gh.reader, TRUNK);
    expect(result.action).toBe('verified');
    expect(result.message).toContain('verified: trunk requires');
    expect(gh.calls).toContain('repos/{owner}/{repo}/branches/trunk/protection');
    expect(gh.calls.some((call) => call.includes('/branches/main/'))).toBe(false);
  });

  it('verifies a ruleset on ~DEFAULT_BRANCH', async () => {
    const result = await verifyBranchRule(ghWithRuleset('trunk', { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }).reader, TRUNK);
    expect(result.action).toBe('verified');
  });

  it('verifies a ruleset on ~ALL', async () => {
    const result = await verifyBranchRule(ghWithRuleset('trunk', { ref_name: { include: ['~ALL'], exclude: [] } }).reader, TRUNK);
    expect(result.action).toBe('verified');
  });

  it('reads an exclusion of trunk, by name or as the default branch, as not protecting it', async () => {
    for (const exclude of ['refs/heads/trunk', '~DEFAULT_BRANCH']) {
      const result = await verifyBranchRule(ghWithRuleset('trunk', { ref_name: { include: ['~ALL'], exclude: [exclude] } }).reader, TRUNK);
      expect(result.action, exclude).toBe('not-applied');
      expect(result.message).toContain('not applied: trunk does not require');
    }
  });

  it('reads a ruleset for main only as not protecting trunk', async () => {
    const result = await verifyBranchRule(ghWithRuleset('trunk', { ref_name: { include: ['refs/heads/main'], exclude: [] } }).reader, TRUNK);
    expect(result.action).toBe('not-applied');
    expect(result.message).toContain('Apply this branch protection on the "trunk" branch:');
  });

  it('cannot tell from a glob that might include trunk, and never calls it protected', async () => {
    const result = await verifyBranchRule(ghWithRuleset('trunk', { ref_name: { include: ['refs/heads/tr*'], exclude: [] } }).reader, TRUNK);
    expect(result.action).toBe('cannot-verify');
    expect(result.message).toContain('cannot confirm it targets trunk');
  });

  it('reads classic protection on trunk, never on main', async () => {
    const gh = recordingGh((endpoint) => {
      if (endpoint === 'repos/{owner}/{repo}/branches/trunk/protection') return { code: 0, stdout: fullProtection, stderr: '' };
      if (endpoint === 'repos/{owner}/{repo}') return { code: 0, stdout: JSON.stringify({ default_branch: 'trunk' }), stderr: '' };
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    });
    const result = await verifyBranchRule(gh.reader, TRUNK);
    expect(result.action).toBe('verified');
    expect(result.message).not.toContain('default branch');
  });
});

describe('the branch the check reads', () => {
  it('says so in one line when GitHub reports another default branch', async () => {
    const gh = ghWithRuleset('trunk', { ref_name: { include: ['~ALL'], exclude: [] } });
    const result = await verifyBranchRule(gh.reader, { name: 'main', source: 'gate' });
    expect(result.action).toBe('verified');
    const lines = result.message.split('\n').filter((line) => line.includes('GitHub reports trunk as the default branch'));
    expect(lines).toEqual([
      'GitHub reports trunk as the default branch, but the gate runs on pull requests into main, so it covers only pull requests into main.',
    ]);
  });

  it('does not count ~DEFAULT_BRANCH for a gate on main when the default branch is trunk', async () => {
    const result = await verifyBranchRule(
      ghWithRuleset('trunk', { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }).reader,
      { name: 'main', source: 'gate' },
    );
    expect(result.action).toBe('not-applied');
  });

  it('checks main and says it assumed it when there is no gate workflow', async () => {
    const target = await gateBranchTarget(async () => null);
    expect(target).toEqual({
      name: 'main',
      source: 'assumed',
      reason: `${USABL_GATE_WORKFLOW_PATH} is missing`,
      gatePresent: false,
      step: 'Run "usabl install --ci" to write the gate for your default branch, then run "usabl install --branch-rule" again.',
    });
    const gh = ghWithRuleset('main', { ref_name: { include: ['refs/heads/main'], exclude: [] } });
    const result = await verifyBranchRule(gh.reader, target);
    expect(result.action).toBe('verified');
    expect(result.message).toContain(
      `usabl assumed main because it could not read the branch your gate runs on: ${USABL_GATE_WORKFLOW_PATH} is missing. GitHub reports main as the default branch.`,
    );
  });

  it('assumes main when the gate trigger is not in the form usabl writes', async () => {
    const drifted = pinEngineRef(gateWorkflowFor('trunk'), SHA).replace('    branches: ["trunk"]', '    branches: [trunk]');
    const target = await gateBranchTarget(async (path) => (path === USABL_GATE_WORKFLOW_PATH ? drifted : null));
    expect(target).toEqual({
      name: 'main',
      source: 'assumed',
      reason: `the trigger in ${USABL_GATE_WORKFLOW_PATH} does not name one branch in the form usabl writes`,
      gatePresent: true,
      step: 'usabl reads only a pull_request trigger that names one branch, quoted, the way usabl writes it. Check the protection on each branch your gate runs on by hand, or run "usabl install --ci" to see how the gate differs from the draft.',
    });
  });

  it('reads the branch from the gate on disk, pinned or not', async () => {
    for (const raw of [gateWorkflowFor('trunk'), pinEngineRef(gateWorkflowFor('trunk'), SHA)]) {
      expect(await gateBranchTarget(async () => raw)).toEqual(TRUNK);
    }
  });

  it('never reads a branch name that would leave the branches path', async () => {
    for (const name of ['..', '.', 'a/../b', 'a//b', '/a', 'a/']) {
      const raw = gateWorkflowFor('trunk').replace('    branches: ["trunk"]', `    branches: ["${name}"]`);
      expect((await gateBranchTarget(async () => raw)).source, name).toBe('assumed');
    }
  });

  it('encodes a branch with a slash as one path segment', async () => {
    const gh = ghWithRuleset('release/2.x', { ref_name: { include: ['refs/heads/release/2.x'], exclude: [] } });
    const result = await verifyBranchRule(gh.reader, { name: 'release/2.x', source: 'gate' });
    expect(result.action).toBe('verified');
    expect(gh.calls[0]).toBe('repos/{owner}/{repo}/branches/release%2F2.x/protection');
  });

  it('prints the setting for the branch it checked', () => {
    expect(branchRuleSetting('trunk')).toContain('Apply this branch protection on the "trunk" branch:');
  });
});

describe('doctor checks the branch the gate names', () => {
  function readOnlyFs(files: Record<string, string>): InstallFs {
    return {
      readFile: async (path) => files[path] ?? null,
      glob: async () => [],
      writeFile: async () => {
        throw new Error('doctor must never write');
      },
    };
  }

  async function branchRule(files: Record<string, string>, gh: GhReader): Promise<SurfaceReport> {
    const reports = await collectDoctorReport({
      fs: readOnlyFs(files),
      gh,
      configPath: 'usabl.config.json',
      env: {},
      probePlaywrightChromium: async () => 'wired',
      probeChromiumSandbox: async () => 'available',
    });
    const found = reports.find((report) => report.id === 'branch-rule');
    if (found === undefined) throw new Error('no branch-rule report');
    return found;
  }

  it('is wired when trunk is protected and the gate runs on trunk', async () => {
    const gh = ghWithRuleset('trunk', { ref_name: { include: ['refs/heads/trunk'], exclude: [] } });
    const report = await branchRule({ [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('trunk'), SHA) }, gh.reader);
    expect(report.state).toBe('wired');
    expect(gh.calls).toContain('repos/{owner}/{repo}/branches/trunk/protection');
  });

  it('is missing, and names trunk, when only main is protected', async () => {
    const gh = ghWithRuleset('trunk', { ref_name: { include: ['refs/heads/main'], exclude: [] } });
    const report = await branchRule({ [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('trunk'), SHA) }, gh.reader);
    expect(report.state).toBe('missing');
    expect(report.nextStep).toContain('The trunk branch does not require');
  });
});
