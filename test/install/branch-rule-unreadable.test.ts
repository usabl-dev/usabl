/**
 * The gate workflow path may hold something usabl cannot read: a folder, or a file it has no
 * permission to read. Then the branch the gate runs on is unknown. The branch rule check does not
 * throw, does not read that as a missing gate, and is not verified. It says the file could not be
 * read and what to do.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { gateBranchTarget, REQUIRED_CHECK, verifyBranchRule } from '../../src/install/branch-rule.js';
import { USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { makeWorkflowReader } from '../../src/deps/fs.js';
import { collectDoctorReport } from '../../src/doctor/index.js';

const fullProtection = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// main fully protected, no rulesets, and GitHub reports main as the default branch: the case where a
// silent "assume main" would end verified.
const ghMainProtected: GhReader = {
  getJson: async (endpoint): Promise<GhResult> => {
    if (endpoint === 'repos/{owner}/{repo}') return { code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
    if (endpoint === 'repos/{owner}/{repo}/branches/main/protection') return { code: 0, stdout: fullProtection, stderr: '' };
    return { code: 0, stdout: '[]', stderr: '' };
  },
};

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: cannot read`), { code });
}

describe('a gate workflow path usabl cannot read', () => {
  it('is a folder: the branch is unknown and the check is not verified', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usabl-gate-folder-'));
    mkdirSync(join(root, USABL_GATE_WORKFLOW_PATH), { recursive: true });
    const target = await gateBranchTarget(makeWorkflowReader(root));
    expect(target).toMatchObject({ name: 'main', source: 'assumed', gatePresent: true });
    const result = await verifyBranchRule(ghMainProtected, target);
    expect(result.action).toBe('cannot-verify');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(`usabl assumed main because it could not read the branch your gate runs on: ${USABL_GATE_WORKFLOW_PATH} could not be read (it is a folder).`);
    expect(result.message).toContain('this result is not verified');
    expect(result.message).toContain(`Make ${USABL_GATE_WORKFLOW_PATH} a file usabl can read, then run "usabl install --branch-rule" again.`);
    expect(result.message).not.toContain('is missing');
  });

  it('has no read permission: no throw, the same refusal', async () => {
    const target = await gateBranchTarget(async () => {
      throw fsError('EACCES');
    });
    expect(target).toMatchObject({ name: 'main', source: 'assumed', gatePresent: true });
    const result = await verifyBranchRule(ghMainProtected, target);
    expect(result.action).toBe('cannot-verify');
    expect(result.message).toContain(`${USABL_GATE_WORKFLOW_PATH} could not be read (usabl has no permission to read it).`);
  });

  it('still lets a programmer error through', async () => {
    await expect(
      gateBranchTarget(async () => {
        throw new TypeError('not a file system error');
      }),
    ).rejects.toThrow(TypeError);
  });

  it('reads as missing only when nothing is there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usabl-gate-none-'));
    const target = await gateBranchTarget(makeWorkflowReader(root));
    expect(target).toMatchObject({ source: 'assumed', reason: `${USABL_GATE_WORKFLOW_PATH} is missing`, gatePresent: false });
  });

  it('gives doctor the same unknown branch, never a missing gate', async () => {
    const reports = await collectDoctorReport({
      fs: {
        readFile: async (path) => {
          if (path === USABL_GATE_WORKFLOW_PATH) throw fsError('EACCES');
          return null;
        },
        glob: async () => [],
        writeFile: async () => {
          throw new Error('doctor must never write');
        },
      },
      gh: ghMainProtected,
      configPath: 'usabl.config.json',
      env: {},
      probePlaywrightChromium: async () => 'wired',
      probeChromiumSandbox: async () => 'available',
    });
    const branchRule = reports.find((report) => report.id === 'branch-rule');
    expect(branchRule?.state).toBe('unknown');
    expect(branchRule?.nextStep).toContain(`${USABL_GATE_WORKFLOW_PATH} could not be read`);
  });
});
