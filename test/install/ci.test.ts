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
  EXPECTED_ENGINE_REF_LINES,
  USABL_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW_PATH,
  USABL_DOCS_GATE_WORKFLOW,
  classifyGateWorkflow,
  countDraftEngineRefLines,
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
  it('keeps the six-job judge split and every fork-safety property', () => {
    // build-app is the only job that runs head code, fenced to pull_request. The judge, the
    // comment, and the policy job are trusted; gate-topology.test.ts holds their full shape.
    expect(USABL_GATE_WORKFLOW).toContain("if: github.event_name == 'pull_request'");
    for (const job of ['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', 'usabl-required']) {
      expect(USABL_GATE_WORKFLOW).toContain(`\n  ${job}:\n`);
    }
    expect(USABL_GATE_WORKFLOW).toContain('git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"');
    expect(USABL_GATE_WORKFLOW).toContain('persist-credentials: false');
    // The numeric PR_NUMBER guard must survive.
    expect(USABL_GATE_WORKFLOW).toContain("''|*[!0-9]*)");
    // Actions stay pinned to full commit SHAs.
    expect(USABL_GATE_WORKFLOW).toContain('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
    expect(USABL_GATE_WORKFLOW).toContain('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
    // The public engine is checked out at the pinned commit with no token, built once, and handed
    // on as a digest-checked archive.
    expect(USABL_GATE_WORKFLOW).toContain('repository: usabl-dev/usabl');
    expect(USABL_GATE_WORKFLOW).toContain('engine_digest');
    expect(USABL_GATE_WORKFLOW).not.toContain('USABL_ENGINE_CHECKOUT_TOKEN');
    expect(USABL_GATE_WORKFLOW).not.toMatch(/^\s*token:/m);
    // The judge serves the build itself and scans it with the isolated browser.
    expect(USABL_GATE_WORKFLOW).toContain('serve-build --dir');
    expect(USABL_GATE_WORKFLOW).toContain('--isolated-browser');
    expect(USABL_GATE_WORKFLOW).not.toContain('npm run dev');
    // Operator build settings are repository variables, so the file stays byte-stable.
    expect(USABL_GATE_WORKFLOW).toContain('${{ vars.USABL_APP_BUILD_COMMAND }}');
    expect(USABL_GATE_WORKFLOW).toContain('${{ vars.USABL_APP_BUILD_DIR }}');
  });

  it('emits a sentinel engine ref and never a fabricated SHA', () => {
    expect(USABL_GATE_WORKFLOW).toContain(`ref: ${ENGINE_REF_PLACEHOLDER}`);
    // The sentinel replaces the ref in the one engine checkout, in usabl-engine.
    const occurrences = USABL_GATE_WORKFLOW.split(ENGINE_REF_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(1);
    // A 40-char hex commit-shaped ref would be a fabricated pin. There must be none on a ref line.
    expect(/^\s*ref: [0-9a-f]{40}\s*$/m.test(USABL_GATE_WORKFLOW)).toBe(false);
  });
});

describe('engine-ref sentinel coupling (guards classifyWorkflow recognition)', () => {
  // classifyWorkflow learns which on-disk lines are variable pins by finding the draft lines
  // whose value is the sentinel. If a draft were ever shipped pre-pinned, or the sentinel
  // renamed, that predicate would match nothing, and every real workflow (even a correctly
  // pinned one) would classify as drifted, degrading doctor to always-drifted with no false
  // wired. These tests pin the invariant, using the same predicate the classifier uses, so a
  // draft edit that breaks recognition fails here instead of silently rotting the signal.
  it('the app gate draft carries exactly the expected number of sentinel ref lines', () => {
    expect(countDraftEngineRefLines(USABL_GATE_WORKFLOW)).toBe(EXPECTED_ENGINE_REF_LINES);
  });

  it('the docs gate draft carries exactly the expected number of sentinel ref lines', () => {
    expect(countDraftEngineRefLines(USABL_DOCS_GATE_WORKFLOW)).toBe(EXPECTED_ENGINE_REF_LINES);
  });

  it('a pre-pinned draft would count zero sentinel ref lines, which is the trap this guards', () => {
    // Demonstrates the failure mode the guard catches: replace the sentinel with a real SHA
    // and the recognizer sees no variable pin line at all.
    const prePinned = USABL_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);
    expect(countDraftEngineRefLines(prePinned)).toBe(0);
  });
});

describe('classifyGateWorkflow', () => {
  it('reports a null (absent) workflow as missing', () => {
    expect(classifyGateWorkflow(null)).toBe('missing');
  });

  it('reports the draft with the sentinel still in place as unpinned, never wired', () => {
    // The draft ships the sentinel at its engine-ref line. It is structurally correct but
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

  it('reports a second engine checkout added beside the pinned one as drifted', () => {
    // There is exactly one engine-ref line, so a half-pinned gate cannot exist. A copied
    // checkout step is a structural change and must never read as wired.
    const extra = PINNED_WORKFLOW.replace(
      `          ref: ${TRUSTED_SHA}\n`,
      `          ref: ${TRUSTED_SHA}\n          ref: ${TRUSTED_SHA}\n`,
    );
    expect(extra).not.toBe(PINNED_WORKFLOW);
    expect(classifyGateWorkflow(extra)).toBe('drifted');
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
    expect(result.message).toContain('usabl-dev/usabl');
    // The engine is public, so the operator sets up no engine secret, and a fork runs the gate.
    expect(result.message).not.toContain('USABL_ENGINE_CHECKOUT_TOKEN');
    expect(result.message).toContain('fork');
    // Any pull request can edit the workflow that judges it, so the install says what protects it.
    expect(result.message).toContain('/.github/workflows/');
    expect(result.message).toContain('CODEOWNERS');
    expect(result.message).toContain('review from code owners');
    expect(result.message).toContain('not evidence');
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

describe('the gate workflow and the saved session', () => {
  // The session `usabl session` saves is a credential under .usabl/. The workflow uploads the
  // engine archive, the build archive, and the Result JSON, and nothing else. The build archive
  // leaves .usabl out even when the build directory is the repository root, so no artifact can
  // carry a session, and the Result never names it.
  it('uploads only the engine, the build, and the Result, never anything under .usabl/', () => {
    for (const workflow of [USABL_GATE_WORKFLOW, USABL_DOCS_GATE_WORKFLOW]) {
      const uploads = [...workflow.matchAll(/uses: actions\/upload-artifact@[^\n]*\n\s+with:\n((?:\s+[a-z-]+:[^\n]*\n)+)/g)];
      expect(uploads.length).toBe(workflow.split('actions/upload-artifact@').length - 1);
      const paths = uploads.map((upload) => /path: ([^\n]+)/.exec(upload[1] ?? '')?.[1]?.trim());
      expect(paths).toEqual([
        '${{ runner.temp }}/usabl-engine.tgz',
        '${{ runner.temp }}/usabl-app-build.tar',
        '${{ runner.temp }}/usabl-judge/usabl-result.json',
      ]);
      const packs = workflow.split('\n').filter((line) => line.includes('--file "${RUNNER_TEMP}/usabl-app-build.tar"'));
      expect(packs).toHaveLength(1);
      expect(packs[0]).toContain('--exclude=./.usabl');
      expect(workflow).not.toContain('.usabl/');
      expect(workflow).not.toContain('storage-state');
    }
  });
});
