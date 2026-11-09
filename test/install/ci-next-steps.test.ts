/**
 * The steps `usabl install --ci` prints after it writes the workflows are only the ones still
 * needed. With the engine pinned, appBaseUrl readable, and no secret to add, that is three steps:
 * commit, add the branch rule, open a pull request. Each thing the run could not settle adds the
 * one step that settles it, in front. These tests pin the exact steps for each case.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import {
  ENGINE_REF_PLACEHOLDER,
  engineRefLineNumber,
  pinEngineRef,
  planDocsCi,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW,
  writeDocsCi,
} from '../../src/install/ci.js';
import { installCi, USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const DIRTY: EnginePin = {
  kind: 'placeholder',
  reason: 'this usabl was built from a tree with uncommitted changes, so its commit is not the code that was built',
};

const READY_APP = {
  'usabl.config.json': JSON.stringify({ appBaseUrl: 'http://127.0.0.1:9000' }),
  'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
};

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

function steps(message: string): string[] {
  const at = message.split('\n').indexOf('Next steps:');
  if (at === -1) return [];
  return message
    .split('\n')
    .slice(at + 1)
    .filter((line) => line !== '');
}

const COMMIT = '1. Review and commit .github/workflows/usabl-gate.yml and .github/workflows/usabl-history.yml.';
const branchRule = (n: number): string =>
  `${n}. Add the branch rule. Run "usabl install --branch-rule": it prints the CODEOWNERS lines and the branch setting that make "usabl-required" the required check. Apply them, then run it again to verify.`;
const openPr = (n: number): string => `${n}. Open a pull request. The gate runs on it, and "usabl-required" reports the result.`;

describe('the steps after install --ci', () => {
  it('lists only commit, the branch rule, and a pull request when nothing else is needed', async () => {
    const result = await installCi(memoryFs(READY_APP), FILLED);

    expect(result.exitCode).toBe(0);
    expect(steps(result.message)).toEqual([COMMIT, branchRule(2), openPr(3)]);
    // The facts that are not steps are still said once, before the steps.
    expect(result.message).toContain(`commit ${SHA}`);
    expect(result.message).toContain('http://127.0.0.1:9000');
    expect(result.message).toContain('needs no secret');
    expect(result.message).toContain('not evidence');
    expect(result.message).toContain('contents: write');
    expect(result.message).not.toContain(ENGINE_REF_PLACEHOLDER);
  });

  it('puts the pin step first when the build has no commit, naming the line in each file', async () => {
    const result = await installCi(memoryFs(READY_APP), DIRTY);

    expect(steps(result.message)).toEqual([
      `1. Pin the engine. The engine ref is still the placeholder ${ENGINE_REF_PLACEHOLDER}, because ${DIRTY.kind === 'placeholder' ? DIRTY.reason : ''}. Until you pin a commit, the usabl-engine job fails and the gate blocks. Edit line ${engineRefLineNumber(USABL_GATE_WORKFLOW)} of .github/workflows/usabl-gate.yml and line ${engineRefLineNumber(USABL_HISTORY_WORKFLOW)} of .github/workflows/usabl-history.yml: replace ${ENGINE_REF_PLACEHOLDER} with a full 40-character commit SHA from usabl-dev/usabl that you trust.`,
      COMMIT.replace('1.', '2.'),
      branchRule(3),
      openPr(4),
    ]);
  });

  it('adds the init step, with the port it read, when usabl.config.json is not there yet', async () => {
    const fs = memoryFs({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --port 3000' } }) });
    const result = await installCi(fs, FILLED);

    expect(steps(result.message)).toEqual([
      '1. Run "usabl init" and commit usabl.config.json. Its appBaseUrl must be http://127.0.0.1:3000: the port read from package.json script "dev". The judge and the history scan both read it.',
      COMMIT.replace('1.', '2.'),
      branchRule(3),
      openPr(4),
    ]);
  });

  it('adds the dev script step when the history workflow has nothing to start', async () => {
    const fs = memoryFs({ 'usabl.config.json': READY_APP['usabl.config.json'], 'package.json': JSON.stringify({ scripts: { 'start:dev': 'webpack serve' } }) });
    const result = await installCi(fs, FILLED);

    expect(steps(result.message)[0]).toBe(
      '1. Add a "dev" script to package.json that starts your dev server. The history workflow runs "npm run dev -- --host <host> --port <port>" with the host and port of appBaseUrl, and package.json has no "dev" script. Or leave .github/workflows/usabl-history.yml out: every run then says tracking is off.',
    );
    expect(steps(result.message)).toHaveLength(4);
  });

  it('lists no steps when both workflows already match and are pinned', async () => {
    const fs = memoryFs({
      ...READY_APP,
      '.github/workflows/usabl-gate.yml': pinEngineRef(USABL_GATE_WORKFLOW, SHA),
      '.github/workflows/usabl-history.yml': pinEngineRef(USABL_HISTORY_WORKFLOW, SHA),
    });
    const result = await installCi(fs, FILLED);

    expect(result).toMatchObject({ exitCode: 0, action: 'already-wired' });
    expect(steps(result.message)).toEqual([]);
  });

  it('still lists the pin step when an earlier placeholder draft is already in place', async () => {
    const fs = memoryFs({
      ...READY_APP,
      '.github/workflows/usabl-gate.yml': USABL_GATE_WORKFLOW,
      '.github/workflows/usabl-history.yml': USABL_HISTORY_WORKFLOW,
    });
    const result = await installCi(fs, DIRTY);

    expect(result.action).toBe('already-wired');
    expect(steps(result.message)).toHaveLength(1);
    expect(steps(result.message)[0]).toMatch(/^1\. Pin the engine\./);
  });

  it('never tells anyone to add a secret', async () => {
    for (const pin of [FILLED, DIRTY]) {
      const result = await installCi(memoryFs({}), pin);
      expect(result.message).not.toMatch(/add a secret|repository secret|personal access token|USABL_ENGINE_CHECKOUT_TOKEN/i);
    }
  });
});

describe('the steps after install --docs-ci', () => {
  it('lists the variables, the docs URL, commit, the branch rule, and a pull request', async () => {
    const fs = memoryFs({});
    const result = await writeDocsCi(fs, await planDocsCi(fs, SHA), FILLED);

    expect(steps(result.message)).toEqual([
      '1. Set three repository variables the docs gate reads: USABL_DOCS_BUILD_COMMAND (for example "ccutil compile"), USABL_DOCS_BUILT_ROOT (the directory the build renders HTML into), and USABL_DOCS_SERVE_PORT (a free port).',
      '2. Point docsBaseUrl in usabl.docs.json at http://127.0.0.1:<USABL_DOCS_SERVE_PORT> so the scan targets the served docs, and commit it.',
      '3. Review and commit .github/workflows/usabl-docs-gate.yml.',
      branchRule(4),
      openPr(5),
    ]);
  });

  it('puts the pin step first without a commit', async () => {
    const fs = memoryFs({});
    const result = await writeDocsCi(fs, await planDocsCi(fs), DIRTY);
    expect(steps(result.message)[0]).toContain(`Edit line ${engineRefLineNumber(USABL_DOCS_GATE_WORKFLOW)} of .github/workflows/usabl-docs-gate.yml`);
    expect(steps(result.message)).toHaveLength(6);
  });
});
