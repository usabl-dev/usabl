/**
 * The docs CI generator emits a security-critical gate workflow for rendered documentation.
 * It is the docs sibling of the app gate: same six-job judge split, same pinned action
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
  it('keeps the six-job judge split and every fork-safety property of the app gate', () => {
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('name: usabl-docs-gate');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain("if: github.event_name == 'pull_request'");
    for (const job of ['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', 'usabl-required']) {
      expect(USABL_DOCS_GATE_WORKFLOW).toContain(`\n  ${job}:\n`);
    }
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('persist-credentials: false');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain("''|*[!0-9]*)");
    // Actions stay pinned to the same full commit SHAs the app gate uses.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('repository: usabl-dev/usabl');
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('USABL_ENGINE_CHECKOUT_TOKEN');
    expect(USABL_DOCS_GATE_WORKFLOW).not.toMatch(/^\s*token:/m);
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('<!-- usabl-report -->');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('check --ci --trusted-ref "origin/${BASE_REF}" --isolated-browser');
    // The review path finds the build by the docs workflow file name, not the app one.
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('--workflow usabl-docs-gate.yml');
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('--workflow usabl-gate.yml');
  });

  it('builds the docs in the untrusted job and serves them from the judge', () => {
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('npm run dev');
    expect(USABL_DOCS_GATE_WORKFLOW).not.toContain('python3 -m http.server');
    expect(USABL_DOCS_GATE_WORKFLOW).toContain('serve-build --dir "${RUNNER_TEMP}/usabl-app" --host 127.0.0.1 --port "${SERVE_PORT}"');
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
    const occurrences = USABL_DOCS_GATE_WORKFLOW.split(ENGINE_REF_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(1);
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

  it('reports a second engine checkout added beside the pinned one as drifted', () => {
    const extra = PINNED_WORKFLOW.replace(
      `          ref: ${TRUSTED_SHA}\n`,
      `          ref: ${TRUSTED_SHA}\n          ref: ${TRUSTED_SHA}\n`,
    );
    expect(extra).not.toBe(PINNED_WORKFLOW);
    expect(classifyDocsGateWorkflow(extra)).toBe('drifted');
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
    expect(result.message).not.toContain('USABL_ENGINE_CHECKOUT_TOKEN');
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
