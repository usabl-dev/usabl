/**
 * Doctor shows what the branch rule check knows about the default branch. When the gate runs on one
 * branch and GitHub reports another as the default, pull requests into the default branch are not
 * gated, so the branch rule surface is not wired and its next step says what to change. When usabl
 * only assumed main and GitHub reports another default branch, the surface says that, not that the
 * read failed.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import type { InstallFs } from '../../src/install/index.js';
import { gateWorkflowFor, pinEngineRef, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// Classic protection on `protectedBranch` only, no rulesets, and a repository whose default branch is
// `defaultBranch`.
function ghProtecting(protectedBranch: string, defaultBranch: string): GhReader {
  return {
    getJson: async (endpoint): Promise<GhResult> => {
      if (endpoint === 'repos/{owner}/{repo}') return { code: 0, stdout: JSON.stringify({ default_branch: defaultBranch }), stderr: '' };
      if (endpoint === `repos/{owner}/{repo}/branches/${protectedBranch}/protection`) return { code: 0, stdout: fullProtection, stderr: '' };
      if (endpoint.includes('/rulesets')) return { code: 0, stdout: '[]', stderr: '' };
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    },
  };
}

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
  const all = await collectDoctorReport({
    fs: readOnlyFs(files),
    gh,
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
  });
  const found = all.find((report) => report.id === 'branch-rule');
  if (found === undefined) throw new Error('no branch-rule report');
  return found;
}

const TRUNK_GATE = { [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('trunk'), SHA) };

describe('doctor and the default branch GitHub reports', () => {
  it('is not wired when the gate runs on trunk, trunk is protected, and GitHub reports main', async () => {
    const report = await branchRule(TRUNK_GATE, ghProtecting('trunk', 'main'));
    expect(report.state).toBe('drifted');
    expect(report.nextStep).toBe(
      'GitHub reports main as the default branch, but the gate runs on pull requests into trunk, so it covers only pull requests into trunk. ' +
        `To gate pull requests into main, put main in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}, and the same in the docs gate and history workflows if you have them. Then run "usabl install --branch-rule" to check the protection on main.`,
    );
  });

  it('prints the same next step from install --branch-rule, which still verifies trunk', async () => {
    const result = await verifyBranchRule(ghProtecting('trunk', 'main'), { name: 'trunk', source: 'gate' });
    expect(result.action).toBe('verified');
    expect(result.message).toContain(
      `To gate pull requests into main, put main in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}, and the same in the docs gate and history workflows if you have them.`,
    );
  });

  it('is wired when the gate runs on trunk and GitHub reports trunk', async () => {
    const report = await branchRule(TRUNK_GATE, ghProtecting('trunk', 'trunk'));
    expect(report.state).toBe('wired');
    expect(report.nextStep).toBe('');
  });

  it('says main was assumed and GitHub reports trunk, when there is no gate', async () => {
    const report = await branchRule({}, ghProtecting('main', 'trunk'));
    expect(report.state).toBe('unknown');
    expect(report.nextStep).toContain('GitHub reports trunk as the default branch, but usabl assumed main');
    expect(report.nextStep).toContain('Run "usabl install --ci" to write the gate for your default branch');
    expect(report.nextStep).not.toContain('gh unavailable');
  });

  it('names the assumed branch in the not applied step', async () => {
    const report = await branchRule({}, ghProtecting('nothing', 'main'));
    expect(report.state).toBe('missing');
    expect(report.nextStep).toContain('The main branch, which usabl assumed, does not require');
  });
});
