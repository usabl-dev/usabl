/**
 * The gate names its branch, that branch is fully protected, and GitHub's answer gives no default
 * branch usabl can use: the read failed, or the answer has no default branch, or one that is not a
 * plain name. usabl then cannot confirm that pull requests into the default branch are gated, so the
 * branch rule check is not verified, and doctor does not read it as wired.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import { gateWorkflowFor, pinEngineRef, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';
import type { InstallFs } from '../../src/install/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// Classic protection on trunk, no rulesets, and this answer for the repository read.
function ghTrunkProtected(repository: GhResult | null): GhReader {
  return {
    getJson: async (endpoint) => {
      if (endpoint === 'repos/{owner}/{repo}') return repository;
      if (endpoint === 'repos/{owner}/{repo}/branches/trunk/protection') return { code: 0, stdout: fullProtection, stderr: '' };
      if (endpoint.includes('/rulesets')) return { code: 0, stdout: '[]', stderr: '' };
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    },
  };
}

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });

// Each answer that gives no default branch usabl can use.
const UNUSABLE: Array<[string, GhResult | null]> = [
  ['the read fails', { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }],
  ['gh gives no answer', null],
  ['the answer has no default_branch', ok('{}')],
  ['default_branch is not a string', ok('{"default_branch":7}')],
  ['default_branch is not a plain name', ok('{"default_branch":"main+x"}')],
  ['the answer is a list', ok('[{"default_branch":"main"}]')],
];

const HEADLINE =
  "cannot verify: the branch rule on trunk is set, but usabl could not read GitHub's default branch, so it cannot confirm that pull requests into the default branch are gated.";

describe('install --branch-rule when GitHub gives no default branch usabl can use', () => {
  for (const [why, repository] of UNUSABLE) {
    it(`is not verified when ${why}, even with the gate branch protected`, async () => {
      const result = await verifyBranchRule(ghTrunkProtected(repository), { name: 'trunk', source: 'gate', line: 8 });
      expect(result.exitCode).toBe(2);
      expect(result.action).toBe('cannot-verify');
      expect(result.otherDefault).toBeNull();
      expect(result.gateBranch?.action).toBe('verified');
      const lines = result.message.split('\n');
      expect(lines[0]).toBe(HEADLINE);
      expect(lines[1]).toMatch(/^trunk requires usabl-required as a required status check, .* \(classic branch protection\)\.$/);
      expect(result.message).toContain('If GitHub\'s default branch is trunk, run "usabl install --branch-rule" again once usabl can read it.');
      expect(result.message).toContain(
        `If it is another branch, put that branch in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}, and the same in the docs gate and history workflows if you have them.`,
      );
    });
  }

  it('names both problems when the gate branch is not protected either', async () => {
    const gh: GhReader = {
      getJson: async (endpoint) => {
        if (endpoint === 'repos/{owner}/{repo}') return { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' };
        return endpoint.includes('/rulesets') ? ok('[]') : { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      },
    };
    const result = await verifyBranchRule(gh, { name: 'trunk', source: 'gate', line: 8 });
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('cannot-verify');
    expect(result.gateBranch?.action).toBe('not-applied');
    expect(result.message.split('\n')[0]).toBe(
      "cannot verify: usabl could not read GitHub's default branch, so it cannot confirm that pull requests into the default branch are gated. The branch rule on trunk is not set either.",
    );
  });
});

describe('doctor when GitHub gives no default branch usabl can use', () => {
  function readOnlyFs(files: Record<string, string>): InstallFs {
    return {
      readFile: async (path) => files[path] ?? null,
      glob: async () => [],
      writeFile: async () => {
        throw new Error('doctor must never write');
      },
    };
  }

  async function branchRule(gh: GhReader): Promise<SurfaceReport> {
    const fs = readOnlyFs({ [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('trunk'), SHA) });
    const reports = await collectDoctorReport({
      fs,
      readWorkflow: fs.readFile,
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

  for (const [why, repository] of UNUSABLE) {
    it(`is unknown, never wired, when ${why}`, async () => {
      const report = await branchRule(ghTrunkProtected(repository));
      expect(report.state).toBe('unknown');
      expect(report.nextStep).toContain(
        "usabl could not read GitHub's default branch, so it cannot confirm that pull requests into the default branch are gated.",
      );
      expect(report.nextStep).toContain(`put that branch in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}`);
    });
  }
});
