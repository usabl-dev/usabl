/**
 * The docs CI generator emits a security-critical gate workflow for rendered documentation.
 * It is the docs sibling of the app gate: same two-job fork-secrets model, same pinned action
 * SHAs, same engine-ref sentinel that is never fabricated. The only differences are the build
 * and serve steps, because usabl does not serve the built docs itself. It writes only when the
 * file is absent, no-ops when byte-identical, and refuses when a hand-tuned workflow differs.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  ENGINE_REF_PLACEHOLDER,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  classifyDocsGateWorkflow,
  planDocsCi,
  writeDocsCi,
} from '../../src/install/ci.js';

const TRUSTED_SHA = '0123456789abcdef0123456789abcdef01234567';
const PINNED_WORKFLOW = USABL_DOCS_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);

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

describe('USABL_DOCS_GATE_WORKFLOW security properties', () => {
  it('keeps the two-job pattern and every fork-safety property of the app gate', () => {
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('name: usabl-docs-gate');
    // gate-comment is the only job allowed to run PR head code, fenced to pull_request.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain("if: github.event_name == 'pull_request'");
    // usabl-policy is the required status check that re-runs on review and reads head as objects only.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('usabl-policy:');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('needs: gate-comment');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('persist-credentials: false');
    // The numeric PR_NUMBER guard must survive.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain("''|*[!0-9]*)");
    // Actions stay pinned to the same full commit SHAs the app gate uses.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e');
    // The private-engine-clone form and its read-only snapshot must remain.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('repository: usabl-dev/usabl');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('cp -a "$GITHUB_WORKSPACE/.usabl-engine" /opt/usabl-trusted');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('Later: npm install usabl');
    // The sticky comment marker and the trusted-ref check must remain.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('<!-- usabl-report -->');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('check --ci --trusted-ref "origin/${BASE_REF}"');
    // The policy job resolves the scan by the docs workflow file name, not the app one.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('--workflow usabl-docs-gate.yml');
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('--workflow usabl-gate.yml');
  });

  it('builds and serves the docs instead of running the app dev server', () => {
    // usabl does not serve the built docs, so the docs job serves them on localhost and scans
    // that origin. The app-only dev server must be absent.
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('npm run dev');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('python3 -m http.server');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('--bind 127.0.0.1');
    // Operator-specific values are repo variables, so the file stays byte-stable and the engine
    // ref remains the only variable classifyDocsGateWorkflow has to reason about.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('${{ vars.USABL_DOCS_BUILD_COMMAND }}');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('${{ vars.USABL_DOCS_BUILT_ROOT }}');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('${{ vars.USABL_DOCS_SERVE_PORT }}');
    // Unset build or serve config fails closed rather than scanning nothing and passing.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('failing closed');
  });

  it('emits a sentinel engine ref and never a fabricated SHA', () => {
    expect(USABL_DOCS_GATE_WORKFLOW).toContain(`ref: ${ENGINE_REF_PLACEHOLDER}`);
    // The sentinel replaces the ref in both engine-checkout steps.
    const occurrences = USABL_DOCS_GATE_WORKFLOW.split(ENGINE_REF_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(2);
    // A 40-char hex commit-shaped ref would be a fabricated pin. There must be none on a ref line.
    expect(/^\s*ref: [0-9a-f]{40}\s*$/m.test(USABL_DOCS_GATE_WORKFLOW)).toBe(false);
  });
});

describe('classifyDocsGateWorkflow', () => {
  it('reports a null (absent) workflow as missing', () => {
    expect(classifyDocsGateWorkflow(null)).toBe('missing');
  });

  it('reports the draft with the sentinel still in place as unpinned, never wired', () => {
    expect(classifyDocsGateWorkflow(USABL_DOCS_GATE_WORKFLOW)).toBe('unpinned');
  });

  it('reports a workflow pinned to a real 40-character commit SHA as wired', () => {
    expect(classifyDocsGateWorkflow(PINNED_WORKFLOW)).toBe('wired');
  });

  it('reports a structural edit outside the engine ref as drifted', () => {
    const tampered = PINNED_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    expect(classifyDocsGateWorkflow(tampered)).toBe('drifted');
  });

  it('reports an added or removed line as drifted', () => {
    expect(classifyDocsGateWorkflow(`# extra header\n${PINNED_WORKFLOW}`)).toBe('drifted');
  });

  it('reports a ref that is neither a full SHA nor the sentinel as drifted', () => {
    const branchPinned = USABL_DOCS_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, 'main');
    expect(classifyDocsGateWorkflow(branchPinned)).toBe('drifted');
    const shortPinned = USABL_DOCS_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, '0123abc');
    expect(classifyDocsGateWorkflow(shortPinned)).toBe('drifted');
    const uppercasePinned = USABL_DOCS_GATE_WORKFLOW.replaceAll(
      ENGINE_REF_PLACEHOLDER,
      TRUSTED_SHA.toUpperCase(),
    );
    expect(classifyDocsGateWorkflow(uppercasePinned)).toBe('drifted');
  });

  it('reports an inconsistent pin (one engine-ref pinned, one still the sentinel) as drifted', () => {
    const halfPinned = USABL_DOCS_GATE_WORKFLOW.replace(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);
    expect(halfPinned).toContain(ENGINE_REF_PLACEHOLDER);
    expect(classifyDocsGateWorkflow(halfPinned)).toBe('drifted');
  });
});

describe('writeDocsCi', () => {
  it('writes the workflow when absent and prints the manual pin and variable steps', async () => {
    const fs = memoryFs({});
    const result = await writeDocsCi(fs, await planDocsCi(fs));

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(USABL_DOCS_GATE_WORKFLOW);
    expect(result.message).toContain(ENGINE_REF_PLACEHOLDER);
    expect(result.message).toContain('USABL_ENGINE_CHECKOUT_TOKEN');
    // The docs gate needs three repo variables and a matching docsBaseUrl. The report must name them.
    expect(result.message).toContain('USABL_DOCS_BUILD_COMMAND');
    expect(result.message).toContain('USABL_DOCS_BUILT_ROOT');
    expect(result.message).toContain('USABL_DOCS_SERVE_PORT');
    expect(result.message).toContain('docsBaseUrl');
  });

  it('no-ops when the on-disk workflow is byte-identical', async () => {
    const fs = memoryFs({ [USABL_DOCS_GATE_WORKFLOW_PATH]: USABL_DOCS_GATE_WORKFLOW });
    const plan = await planDocsCi(fs);
    expect(plan.action).toBe('already-wired');
    const result = await writeDocsCi(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('already-wired');
  });

  it('is idempotent as a round-trip: a second write on the just-written store no-ops', async () => {
    const fs = memoryFs({});
    const first = await writeDocsCi(fs, await planDocsCi(fs));
    expect(first.action).toBe('written');

    const second = await writeDocsCi(fs, await planDocsCi(fs));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(USABL_DOCS_GATE_WORKFLOW);
  });

  it('refuses to overwrite a workflow that differs, and points at the difference', async () => {
    const tuned = USABL_DOCS_GATE_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const fs = memoryFs({ [USABL_DOCS_GATE_WORKFLOW_PATH]: tuned });
    const result = await writeDocsCi(fs, await planDocsCi(fs));

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(tuned);
    expect(result.message.toLowerCase()).toContain('reconcile');
    expect(result.message).toContain('line');
  });
});
