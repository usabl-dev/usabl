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
  classifyGateWorkflow,
  planCi,
  writeCi,
} from '../../src/install/ci.js';

const TRUSTED_SHA = '0123456789abcdef0123456789abcdef01234567';
const PINNED_WORKFLOW = USABL_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);

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

describe('classifyGateWorkflow', () => {
  it('reports a null (absent) workflow as missing', () => {
    expect(classifyGateWorkflow(null)).toBe('missing');
  });

  it('reports the draft with the sentinel still in place as unpinned, never wired', () => {
    // The draft ships the sentinel at both engine-ref lines. It is structurally correct but
    // not yet enforceable, so it must not read as wired. This is the honesty inversion the
    // rework fixes: byte-identical-to-draft is unpinned, not wired.
    expect(classifyGateWorkflow(USABL_GATE_WORKFLOW)).toBe('unpinned');
  });

  it('reports a workflow pinned to a real 40-character commit SHA as wired', () => {
    expect(classifyGateWorkflow(PINNED_WORKFLOW)).toBe('wired');
  });

  it('reports a structural edit outside the engine ref as drifted', () => {
    const tampered = PINNED_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    expect(classifyGateWorkflow(tampered)).toBe('drifted');
  });

  it('reports an added or removed line as drifted', () => {
    expect(classifyGateWorkflow(`# extra header\n${PINNED_WORKFLOW}`)).toBe('drifted');
  });

  it('reports a ref that is neither a full SHA nor the sentinel as drifted', () => {
    // A branch name, a tag, or a short SHA is not a trusted pin usabl can confirm.
    const branchPinned = USABL_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, 'main');
    expect(classifyGateWorkflow(branchPinned)).toBe('drifted');
    const shortPinned = USABL_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, '0123abc');
    expect(classifyGateWorkflow(shortPinned)).toBe('drifted');
    const uppercasePinned = USABL_GATE_WORKFLOW.replaceAll(
      ENGINE_REF_PLACEHOLDER,
      TRUSTED_SHA.toUpperCase(),
    );
    expect(classifyGateWorkflow(uppercasePinned)).toBe('drifted');
  });

  it('reports an inconsistent pin (one engine-ref pinned, one still the sentinel) as drifted', () => {
    // Replace only the first sentinel occurrence, leaving the second unpinned. A half-pinned
    // gate is not enforceable, so it is drifted, never wired.
    const halfPinned = USABL_GATE_WORKFLOW.replace(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);
    expect(halfPinned).toContain(ENGINE_REF_PLACEHOLDER);
    expect(classifyGateWorkflow(halfPinned)).toBe('drifted');
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

  it('is idempotent as a round-trip: a second write on the just-written store no-ops', async () => {
    // Write into an empty store, then plan and write again against what the first write left
    // behind. The second pass must recognize its own output and change nothing.
    const fs = memoryFs({});
    const first = await writeCi(fs, await planCi(fs));
    expect(first.action).toBe('written');

    const second = await writeCi(fs, await planCi(fs));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(USABL_GATE_WORKFLOW);
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
