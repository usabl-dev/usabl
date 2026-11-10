/**
 * A documentation repository may have only the docs gate. Its docs gate requires the same
 * usabl-required check, so with no app gate workflow the branch rule check and doctor read the branch
 * the docs gate names, and their advice names "usabl install --docs-ci". When both gates are there,
 * the app gate's branch is the one checked, and install's step for files that name different
 * branches is what tells the person they disagree.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { gateBranchTarget, REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import {
  docsGateWorkflowFor,
  gateWorkflowFor,
  pinEngineRef,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import type { InstallFs } from '../../src/install/index.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

function ghProtecting(protectedBranch: string, defaultBranch: string): { reader: GhReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      getJson: async (endpoint): Promise<GhResult> => {
        calls.push(endpoint);
        if (endpoint === 'repos/{owner}/{repo}') return { code: 0, stdout: JSON.stringify({ default_branch: defaultBranch }), stderr: '' };
        if (endpoint === `repos/{owner}/{repo}/branches/${protectedBranch}/protection`) return { code: 0, stdout: fullProtection, stderr: '' };
        if (endpoint.includes('/rulesets')) return { code: 0, stdout: '[]', stderr: '' };
        return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      },
    },
  };
}

const files =
  (on: Record<string, string>) =>
  async (path: string): Promise<string | null> =>
    on[path] ?? null;

const docsGate = (branch: string): Record<string, string> => ({ [USABL_DOCS_GATE_WORKFLOW_PATH]: pinEngineRef(docsGateWorkflowFor(branch), SHA) });

describe('the branch rule check in a repository with only the docs gate', () => {
  it('checks trunk when the docs gate names trunk', async () => {
    const target = await gateBranchTarget(files(docsGate('trunk')));
    expect(target).toEqual({ name: 'trunk', source: 'docs-gate' });
    const gh = ghProtecting('trunk', 'trunk');
    const result = await verifyBranchRule(gh.reader, target);
    expect(result.action).toBe('verified');
    expect(result.message).toContain('verified: trunk requires');
    expect(result.message).not.toContain('assumed');
    expect(result.message).not.toContain('install --ci');
    expect(gh.calls.some((call) => call.includes('/branches/main/'))).toBe(false);
  });

  it('checks main, not assumed, when the docs gate names main', async () => {
    const target = await gateBranchTarget(files(docsGate('main')));
    expect(target).toEqual({ name: 'main', source: 'docs-gate' });
    const result = await verifyBranchRule(ghProtecting('main', 'main').reader, target);
    expect(result.action).toBe('verified');
    expect(result.message).not.toContain('assumed');
  });

  it('names the docs gate in the setting it prints', async () => {
    const result = await verifyBranchRule(ghProtecting('nothing', 'trunk').reader, await gateBranchTarget(files(docsGate('trunk'))));
    expect(result.action).toBe('not-applied');
    expect(result.message).toContain(`(the aggregate job in ${USABL_DOCS_GATE_WORKFLOW_PATH})`);
    expect(result.message).not.toContain(`(the aggregate job in ${USABL_GATE_WORKFLOW_PATH})`);
  });

  it('names the docs gate file and its lines when GitHub reports another default branch', async () => {
    const result = await verifyBranchRule(ghProtecting('trunk', 'main').reader, await gateBranchTarget(files(docsGate('trunk'))));
    expect(result.message).toContain(`put main in place of trunk on line 8 of ${USABL_DOCS_GATE_WORKFLOW_PATH}`);
  });

  it('says to run install --docs-ci, never install --ci, when the docs gate trigger cannot be read', async () => {
    const drifted = docsGate('trunk')[USABL_DOCS_GATE_WORKFLOW_PATH]!.replace('    branches: ["trunk"]', '    branches: [trunk]');
    const target = await gateBranchTarget(files({ [USABL_DOCS_GATE_WORKFLOW_PATH]: drifted }));
    expect(target.source).toBe('assumed');
    const result = await verifyBranchRule(ghProtecting('main', 'trunk').reader, target);
    expect(result.action).toBe('cannot-verify');
    expect(result.message).toContain(`the trigger in ${USABL_DOCS_GATE_WORKFLOW_PATH} does not name one branch in the form usabl writes`);
    expect(result.message).toContain('usabl install --docs-ci');
    expect(result.message).not.toContain('install --ci');
  });
});

describe('the branch rule check with both gates', () => {
  it('checks the branch the app gate names', async () => {
    const both = { [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('main'), SHA), ...docsGate('trunk') };
    expect(await gateBranchTarget(files(both))).toEqual({ name: 'main', source: 'gate' });
  });
});

describe('doctor in a repository with only the docs gate', () => {
  async function branchRule(on: Record<string, string>, gh: GhReader): Promise<SurfaceReport> {
    const fs: InstallFs = {
      readFile: async (path) => on[path] ?? null,
      glob: async () => [],
      writeFile: async () => {
        throw new Error('doctor must never write');
      },
    };
    const all = await collectDoctorReport({
      fs,
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

  it('checks the branch the docs gate names, and reads it as wired', async () => {
    const gh = ghProtecting('trunk', 'trunk');
    const report = await branchRule(docsGate('trunk'), gh.reader);
    expect(report.label).toBe(`branch protection (trunk requires ${REQUIRED_CHECK})`);
    expect(report.state).toBe('wired');
    expect(gh.calls).toContain('repos/{owner}/{repo}/branches/trunk/protection');
  });

  it('names install --docs-ci when the docs gate trigger cannot be read', async () => {
    const drifted = docsGate('trunk')[USABL_DOCS_GATE_WORKFLOW_PATH]!.replace('    branches: ["trunk"]', '    branches: [trunk]');
    const report = await branchRule({ [USABL_DOCS_GATE_WORKFLOW_PATH]: drifted }, ghProtecting('main', 'trunk').reader);
    expect(report.nextStep).toContain('usabl install --docs-ci');
    expect(report.nextStep).not.toContain('install --ci');
  });
});
