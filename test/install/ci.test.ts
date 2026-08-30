/**
 * The CI generator emits a security-critical gate workflow. It writes only when the
 * file is absent, no-ops when byte-identical, and refuses when a hand-tuned workflow
 * differs. It never fabricates the trusted engine SHA: it emits a documented sentinel
 * and prints the manual pin step. The refusal guard is asserted to be load-bearing so
 * usabl can never silently overwrite an operator's tuned gate.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  ENGINE_REF_PLACEHOLDER,
  USABL_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW_PATH,
  planCi,
  writeCi,
} from '../../src/install/ci.js';

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

describe('USABL_GATE_WORKFLOW security properties', () => {
  it('keeps the two-job pattern and every fork-safety property', () => {
    // gate-comment is the only job allowed to run PR head code, fenced to pull_request.
    expect(USABL_GATE_WORKFLOW).toContain("if: github.event_name == 'pull_request'");
    // usabl-policy is the required status check that re-runs on review and reads head as objects only.
    expect(USABL_GATE_WORKFLOW).toContain('usabl-policy:');
    expect(USABL_GATE_WORKFLOW).toContain('needs: gate-comment');
    expect(USABL_GATE_WORKFLOW).toContain('git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"');
    expect(USABL_GATE_WORKFLOW).toContain('persist-credentials: false');
    // The numeric PR_NUMBER guard must survive.
    expect(USABL_GATE_WORKFLOW).toContain("''|*[!0-9]*)");
    // Actions stay pinned to full commit SHAs.
    expect(USABL_GATE_WORKFLOW).toContain('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
    expect(USABL_GATE_WORKFLOW).toContain('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
    // The private-engine-clone form and its read-only snapshot must remain.
    expect(USABL_GATE_WORKFLOW).toContain('repository: usabl-dev/usabl');
    expect(USABL_GATE_WORKFLOW).toContain('cp -a "$GITHUB_WORKSPACE/.usabl-engine" /opt/usabl-trusted');
    expect(USABL_GATE_WORKFLOW).toContain('Later: npm install usabl');
  });

  it('emits a sentinel engine ref and never a fabricated SHA', () => {
    expect(USABL_GATE_WORKFLOW).toContain(`ref: ${ENGINE_REF_PLACEHOLDER}`);
    // The sentinel replaces the ref in both engine-checkout steps.
    const occurrences = USABL_GATE_WORKFLOW.split(ENGINE_REF_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(2);
    // A 40-char hex commit-shaped ref would be a fabricated pin. There must be none on a ref line.
    expect(/^\s*ref: [0-9a-f]{40}\s*$/m.test(USABL_GATE_WORKFLOW)).toBe(false);
  });
});

describe('writeCi', () => {
  it('writes the workflow when absent and prints the manual pin step', async () => {
    const fs = memoryFs({});
    const result = await writeCi(fs, await planCi(fs));

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(USABL_GATE_WORKFLOW);
    expect(result.message).toContain(ENGINE_REF_PLACEHOLDER);
    expect(result.message).toContain('USABL_ENGINE_CHECKOUT_TOKEN');
    expect(result.message).toContain('usabl-dev/usabl');
  });

  it('no-ops when the on-disk workflow is byte-identical', async () => {
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: USABL_GATE_WORKFLOW });
    const plan = await planCi(fs);
    expect(plan.action).toBe('already-wired');
    const result = await writeCi(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('already-wired');
  });

  it('refuses to overwrite a workflow that differs, and points at the difference', async () => {
    const tuned = USABL_GATE_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: tuned });
    const result = await writeCi(fs, await planCi(fs));

    // Load-bearing: exit 2 and the tuned file untouched. If usabl overwrote a
    // hand-tuned security workflow, both assertions flip red.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(tuned);
    expect(result.message.toLowerCase()).toContain('reconcile');
    expect(result.message).toContain('line');
  });
});
