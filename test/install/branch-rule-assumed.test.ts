/**
 * A branch usabl only assumed is never reported as fact, and a check on a branch usabl only
 * assumed never ends as verified. When no gate workflow names a branch, the check reads main and
 * says it assumed main in every line that names it. When GitHub reports another default branch, the
 * result is not verified: it names both branches and the next step. When GitHub reports main, main
 * is no longer only assumed, so full protection on main is verified, and the lines still say how
 * usabl chose it.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { gateBranchTarget, REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import { gateWorkflowFor, pinEngineRef, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

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

const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// Classic protection on `protectedBranch` only, no rulesets, and a repository whose default branch
// is `defaultBranch`, or a repository read that fails when it is null.
function ghProtecting(protectedBranch: string, defaultBranch: string | null): ReturnType<typeof recordingGh> {
  return recordingGh((endpoint) => {
    if (endpoint === 'repos/{owner}/{repo}') {
      return defaultBranch === null
        ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : { code: 0, stdout: JSON.stringify({ default_branch: defaultBranch }), stderr: '' };
    }
    if (endpoint === `repos/{owner}/{repo}/branches/${protectedBranch}/protection`) return { code: 0, stdout: fullProtection, stderr: '' };
    if (endpoint.includes('/rulesets')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
  });
}

const noGate = async (): Promise<string | null> => null;

// Every line that names main, except a read-only command a person can paste, says main was assumed.
function linesNamingMain(message: string): string[] {
  return message.split('\n').filter((line) => /\bmain\b/.test(line) && !line.trimStart().startsWith('gh api'));
}

describe('the branch rule check on an assumed main', () => {
  it('is not verified when GitHub reports trunk as the default branch, and names both branches and the next step', async () => {
    const gh = ghProtecting('main', 'trunk');
    const result = await verifyBranchRule(gh.reader, await gateBranchTarget(noGate));
    expect(result.action).toBe('cannot-verify');
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toContain('verified:');
    expect(result.message).not.toContain('the gate runs on pull requests into main');
    expect(result.message).toContain(
      `cannot verify: GitHub reports trunk as the default branch, but usabl assumed main because it could not read the branch your gate runs on: ${USABL_GATE_WORKFLOW_PATH} is missing. usabl did not check the protection on trunk, so this result is not verified.`,
    );
    expect(result.message).toContain('Run "usabl install --ci" to write the gate for your default branch, then run "usabl install --branch-rule" again.');
    for (const line of linesNamingMain(result.message)) expect(line).toContain('assumed');
  });

  it('is verified when GitHub reports main as the default branch, and says in each line that main was assumed', async () => {
    // Safe: GitHub names main as the default branch, so main is no longer only assumed. The verified
    // line claims only the protection on main, which usabl read in full. No gate file exists, so no
    // gate runs on some other branch that this check missed.
    const gh = ghProtecting('main', 'main');
    const result = await verifyBranchRule(gh.reader, await gateBranchTarget(noGate));
    expect(result.action).toBe('verified');
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain('the gate runs on');
    expect(result.message.split('\n')).toEqual([
      `verified: main (assumed) requires ${REQUIRED_CHECK} as a required status check, review from code owners, at least one approving review, and dismissal of stale approvals on push (classic branch protection).`,
      `usabl assumed main because it could not read the branch your gate runs on: ${USABL_GATE_WORKFLOW_PATH} is missing. GitHub reports main as the default branch.`,
      'Run "usabl install --ci" to write the gate for your default branch, then run "usabl install --branch-rule" again.',
    ]);
  });

  it('says main was assumed in every line of a not applied result', async () => {
    const gh = ghProtecting('nothing', 'main');
    const result = await verifyBranchRule(gh.reader, await gateBranchTarget(noGate));
    expect(result.action).toBe('not-applied');
    expect(result.message).toContain('not applied: main (assumed) does not require');
    expect(result.message).toContain('Apply this branch protection on the "main" branch, which usabl assumed:');
    for (const line of linesNamingMain(result.message)) expect(line).toContain('assumed');
  });

  it('is not verified when GitHub does not say which branch is the default', async () => {
    const gh = ghProtecting('main', null);
    const result = await verifyBranchRule(gh.reader, await gateBranchTarget(noGate));
    expect(result.action).toBe('cannot-verify');
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toContain('verified:');
    expect(result.message).toContain('could not read the default branch from GitHub either, so main is not confirmed and this result is not verified.');
    for (const line of linesNamingMain(result.message)) expect(line).toContain('assumed');
  });

  it('is not verified when a gate file is present but its branch cannot be read, even on main', async () => {
    const drifted = pinEngineRef(gateWorkflowFor('trunk'), SHA).replace('    branches: ["trunk"]', '    branches: [trunk, release]');
    const target = await gateBranchTarget(async (path) => (path === USABL_GATE_WORKFLOW_PATH ? drifted : null));
    const result = await verifyBranchRule(ghProtecting('main', 'main').reader, target);
    expect(result.action).toBe('cannot-verify');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('A gate workflow is present, so usabl cannot confirm the gate runs on main (assumed), and this result is not verified.');
    expect(result.message).toContain('Check the protection on each branch your gate runs on by hand');
    for (const line of linesNamingMain(result.message)) expect(line).toContain('assumed');
  });
});

describe('the branch rule check on a gate that names trunk', () => {
  it('is verified when GitHub reports trunk as the default branch, with no line about the branch', async () => {
    const gate = pinEngineRef(gateWorkflowFor('trunk'), SHA);
    const target = await gateBranchTarget(async (path) => (path === USABL_GATE_WORKFLOW_PATH ? gate : null));
    const result = await verifyBranchRule(ghProtecting('trunk', 'trunk').reader, target);
    expect(result.action).toBe('verified');
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain('assumed');
    expect(result.message).not.toContain('default branch');
    expect(result.message.split('\n')).toHaveLength(1);
  });
});

describe('the default branch GitHub reports', () => {
  it('is never printed or trusted when it is not a plain branch name', async () => {
    for (const name of ['main\u001b[31m', 'trunk\nverified: main', 'a b']) {
      const result = await verifyBranchRule(ghProtecting('main', name).reader, await gateBranchTarget(noGate));
      expect(result.action, JSON.stringify(name)).toBe('cannot-verify');
      expect(result.message).not.toContain('\u001b');
      expect(result.message).not.toContain('a b');
      expect(result.message.split('\n').filter((line) => line.startsWith('verified:'))).toEqual([]);
    }
  });
});
