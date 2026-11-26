/**
 * `usabl install --branch-rule` and `usabl doctor` read the same files and ask GitHub the same
 * questions, so they must give the same answer about the branch rule. These tests run both commands
 * through main() in a real folder, with a stand-in gh on PATH that answers from fixed data, and
 * compare what each says: the branch it checked, why, and whether the result is verified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { main } from '../../src/cli.js';
import { REQUIRED_CHECK } from '../../src/install/branch-rule.js';
import { docsGateWorkflowFor, gateWorkflowFor, pinEngineRef, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';

// The sandbox probe starts a real Chromium. These tests compare two commands, so it answers at once.
vi.mock('../../src/doctor/sandbox-probe.js', () => ({ probeChromiumSandbox: async () => 'available' }));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FULL_PROTECTION = JSON.stringify({
  required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK, app_id: -1 }] },
  required_pull_request_reviews: { require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1 },
});

// A stand-in for gh: GitHub reports defaultBranch as the default branch, or the repository read
// fails when it is null, classic protection on each protected branch, no rulesets, and no
// protection anywhere else.
function fakeGhScript(defaultBranch: string | null, protectedBranches: string[]): string {
  const protectedCases = protectedBranches.map(
    (branch) => `  'repos/{owner}/{repo}/branches/${branch}/protection') printf '%s\\n' '${FULL_PROTECTION}' ;;`,
  );
  return [
    '#!/bin/sh',
    'case "$2" in',
    defaultBranch === null
      ? `  'repos/{owner}/{repo}') printf 'gh: Server Error (HTTP 502)\\n' >&2; exit 1 ;;`
      : `  'repos/{owner}/{repo}') printf '%s\\n' '{"default_branch":"${defaultBranch}"}' ;;`,
    ...protectedCases,
    `  *rulesets*) printf '[]\\n' ;;`,
    `  *) printf 'gh: Branch not protected (HTTP 404)\\n' >&2; exit 1 ;;`,
    'esac',
    '',
  ].join('\n');
}

interface BranchAnswer {
  installCode: number;
  installText: string;
  doctorState: string;
  doctorLabel: string;
  doctorStep: string;
}

describe('install --branch-rule and doctor agree on the branch rule', () => {
  let workspace: string;
  let originalCwd: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-branch-agree-'));
    process.chdir(workspace);
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    // A file made unreadable for a test must be readable again before it can be removed.
    await chmod(join(workspace, USABL_GATE_WORKFLOW_PATH), 0o755).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  async function useGh(defaultBranch: string | null, protectedBranches: string[]): Promise<void> {
    const bin = join(workspace, '.fake-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'gh'), fakeGhScript(defaultBranch, protectedBranches), { encoding: 'utf8', mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
  }

  async function writeWorkflow(path: string, contents: string): Promise<void> {
    await mkdir(join(workspace, dirname(path)), { recursive: true });
    await writeFile(join(workspace, path), contents, 'utf8');
  }

  async function answers(): Promise<BranchAnswer> {
    out.length = 0;
    err.length = 0;
    const installCode = await main(['install', '--branch-rule']);
    const installText = out.join('') + err.join('');
    out.length = 0;
    err.length = 0;
    expect(await main(['doctor'])).toBe(0);
    const lines = out.join('').split('\n');
    const at = lines.findIndex((line) => /^ {2}\[[a-z]+\] branch protection \(/.test(line));
    if (at === -1) throw new Error(`no branch rule line in doctor output:\n${lines.join('\n')}`);
    const head = /^ {2}\[([a-z]+)\] (.*)$/.exec(lines[at] ?? '');
    return {
      installCode,
      installText,
      doctorState: head?.[1] ?? '',
      doctorLabel: head?.[2] ?? '',
      doctorStep: (lines[at + 1] ?? '').trim(),
    };
  }

  describe('when the gate path cannot be read', () => {
    it('reads a folder at the gate path as unreadable in both, and never as wired', async () => {
      await useGh('main', ['main']);
      await mkdir(join(workspace, USABL_GATE_WORKFLOW_PATH), { recursive: true });
      const reason = `${USABL_GATE_WORKFLOW_PATH} could not be read (it is a folder)`;

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText).toContain('cannot verify: main (assumed) requires');
      expect(answer.installText).toContain(reason);
      expect(answer.doctorState).toBe('unknown');
      expect(answer.doctorLabel).toBe(`branch protection (main, assumed, requires ${REQUIRED_CHECK})`);
      expect(answer.doctorStep).toContain(reason);
      expect(answer.doctorStep).not.toContain('is missing');
    });

    it('never falls back to the docs gate branch when the gate path is a folder', async () => {
      await useGh('main', ['main', 'trunk']);
      await mkdir(join(workspace, USABL_GATE_WORKFLOW_PATH), { recursive: true });
      await writeWorkflow(USABL_DOCS_GATE_WORKFLOW_PATH, pinEngineRef(docsGateWorkflowFor('trunk'), SHA));

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText).toContain(`${USABL_GATE_WORKFLOW_PATH} could not be read (it is a folder)`);
      expect(answer.doctorState).toBe('unknown');
      expect(answer.doctorLabel).toBe(`branch protection (main, assumed, requires ${REQUIRED_CHECK})`);
      expect(answer.doctorStep).toContain(`${USABL_GATE_WORKFLOW_PATH} could not be read (it is a folder)`);
      expect(answer.doctorStep).not.toContain('trunk');
    });

    it.skipIf(process.getuid?.() === 0)('reads a file with no read permission as unreadable in both (root reads any file, so this is skipped as root)', async () => {
      await useGh('main', ['main']);
      await writeWorkflow(USABL_GATE_WORKFLOW_PATH, pinEngineRef(gateWorkflowFor('main'), SHA));
      await chmod(join(workspace, USABL_GATE_WORKFLOW_PATH), 0o000);
      const reason = `${USABL_GATE_WORKFLOW_PATH} could not be read (usabl has no permission to read it)`;

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText).toContain(reason);
      expect(answer.doctorState).toBe('unknown');
      expect(answer.doctorLabel).toBe(`branch protection (main, assumed, requires ${REQUIRED_CHECK})`);
      expect(answer.doctorStep).toContain(reason);
    });

    it('reads no gate file as missing in both, as before', async () => {
      await useGh('main', ['main']);

      const answer = await answers();

      expect(answer.installCode).toBe(0);
      expect(answer.installText).toContain('verified: main (assumed) requires');
      expect(answer.installText).toContain(`${USABL_GATE_WORKFLOW_PATH} is missing`);
      expect(answer.doctorState).toBe('wired');
      expect(answer.doctorLabel).toBe(`branch protection (main, assumed, requires ${REQUIRED_CHECK})`);
    });
  });

  describe("when GitHub's default branch is not the gate's branch", () => {
    const fixLine = `To gate pull requests into main, put main in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}, and the same in the docs gate and history workflows if you have them. Then run "usabl install --branch-rule" to check the protection on main.`;

    it('is not verified in either when the gate branch is protected, and both name the same fix', async () => {
      await useGh('main', ['trunk']);
      await writeWorkflow(USABL_GATE_WORKFLOW_PATH, pinEngineRef(gateWorkflowFor('trunk'), SHA));

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText.split('\n')[0]).toBe(
        'cannot verify: the branch rule on trunk is set, but GitHub reports main as the default branch, and pull requests into main are not gated.',
      );
      expect(answer.installText).toContain(fixLine);
      expect(answer.doctorState).toBe('drifted');
      expect(answer.doctorLabel).toBe(`branch protection (trunk requires ${REQUIRED_CHECK})`);
      expect(answer.doctorStep).toContain('GitHub reports main as the default branch, but the gate runs on pull requests into trunk, so pull requests into main are not gated.');
      expect(answer.doctorStep).toContain(fixLine);
    });

    it('is not verified in either when the gate branch is not protected, and both name both problems', async () => {
      await useGh('main', []);
      await writeWorkflow(USABL_GATE_WORKFLOW_PATH, pinEngineRef(gateWorkflowFor('trunk'), SHA));

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText.split('\n')[0]).toBe(
        'cannot verify: GitHub reports main as the default branch, and pull requests into main are not gated. The branch rule on trunk is not set either.',
      );
      expect(answer.installText).toContain(fixLine);
      expect(answer.doctorState).toBe('missing');
      expect(answer.doctorStep).toContain('The trunk branch does not require all of');
      expect(answer.doctorStep).toContain('GitHub reports main as the default branch, but the gate runs on pull requests into trunk, so pull requests into main are not gated.');
      expect(answer.doctorStep).toContain(fixLine);
    });

    it('is not verified in either when GitHub cannot say which branch is the default', async () => {
      await useGh(null, ['trunk']);
      await writeWorkflow(USABL_GATE_WORKFLOW_PATH, pinEngineRef(gateWorkflowFor('trunk'), SHA));

      const answer = await answers();

      expect(answer.installCode).toBe(2);
      expect(answer.installText.split('\n')[0]).toBe(
        "cannot verify: the branch rule on trunk is set, but usabl could not read GitHub's default branch, so it cannot confirm that pull requests into the default branch are gated.",
      );
      expect(answer.doctorState).toBe('unknown');
      expect(answer.doctorStep).toContain("usabl could not read GitHub's default branch, so it cannot confirm that pull requests into the default branch are gated.");
      expect(answer.doctorStep).toContain(`put that branch in place of trunk on line 8 of ${USABL_GATE_WORKFLOW_PATH}`);
    });

    it('is verified and wired in both when the default branch is the gate branch', async () => {
      await useGh('trunk', ['trunk']);
      await writeWorkflow(USABL_GATE_WORKFLOW_PATH, pinEngineRef(gateWorkflowFor('trunk'), SHA));

      const answer = await answers();

      expect(answer.installCode).toBe(0);
      expect(answer.installText).toContain('verified: trunk requires');
      expect(answer.installText).not.toContain('default branch');
      expect(answer.doctorState).toBe('wired');
      expect(answer.doctorLabel).toBe(`branch protection (trunk requires ${REQUIRED_CHECK})`);
    });
  });
});
