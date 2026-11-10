/**
 * The text inside the generated workflows must be true on every app, whatever its default branch.
 * Comments and step names say "the default branch" where they mean it; only the trigger lines and
 * the history scan's `if:` carry the name. Every generated workflow and every line install prints
 * says "accessibility barriers", never a bare "barriers".
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import { docsGateWorkflowFor, gateWorkflowFor, pinEngineRef } from '../../src/install/ci.js';
import { historyWorkflow, installCi } from '../../src/install/history-ci.js';
import { installDocsCi } from '../../src/install/docs-ci.js';
import { branchRuleSetting, verifyBranchRule } from '../../src/install/branch-rule.js';
import { NO_GIT } from '../../src/install/repo-git.js';
import { fakeGit } from './fake-git.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const DIRTY: EnginePin = { kind: 'placeholder', reason: 'this usabl was built outside git' };

const DRAFTS: Array<[string, (branch: string) => string]> = [
  ['the app gate', gateWorkflowFor],
  ['the docs gate', docsGateWorkflowFor],
  ['the history workflow', historyWorkflow],
];

function memoryFs(files: Record<string, string>): InstallFs {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
  };
}

// A bare "barrier" or "barriers", in any case, that does not follow "accessibility ".
function bareBarriers(text: string): string[] {
  return text.split('\n').filter((line) => /(?<!accessibility )\bbarriers?\b/i.test(line));
}

describe('the text inside each workflow does not depend on the branch', () => {
  it.each(DRAFTS)('%s says "main" nowhere but in the lines that carry the branch', (_name, draftFor) => {
    const main = draftFor('main').split('\n');
    const other = draftFor('trunk').split('\n');
    const carryBranch = new Set(main.flatMap((line, index) => (line === other[index] ? [] : [index])));
    // The embedded scripts name a function main(); that is code, not a branch.
    const mainLines = main.filter((line, index) => !carryBranch.has(index) && /\bmain\b(?!\()/.test(line));
    expect(mainLines).toEqual([]);
  });

  it('names the default branch in the history step names', () => {
    const history = historyWorkflow('trunk');
    expect(history).toContain('      - name: Checkout the default branch\n');
    expect(history).toContain('      - name: Scan the default branch and write the history record\n');
    expect(history).toContain('      - name: Checkout the default branch without running it\n');
  });
});

describe('every generated workflow and install line says "accessibility barriers"', () => {
  it('finds a bare "barriers", so the sweep below proves something', () => {
    expect(bareBarriers('see the usabl comment for the barriers\nfixes 2 accessibility barriers\nA Barrier here')).toHaveLength(2);
  });

  it.each(DRAFTS)('%s', (_name, draftFor) => {
    for (const branch of ['main', 'trunk']) {
      expect(bareBarriers(draftFor(branch))).toEqual([]);
      expect(bareBarriers(pinEngineRef(draftFor(branch), SHA))).toEqual([]);
    }
  });

  it('the gate says where to read the accessibility barriers when the verdict is not pass', () => {
    expect(gateWorkflowFor('main')).toContain('see the usabl comment for the accessibility barriers');
  });

  it('install --ci, install --docs-ci, and install --branch-rule print none', async () => {
    const messages: string[] = [];
    for (const pin of [FILLED, DIRTY]) {
      for (const git of [NO_GIT, fakeGit('trunk')]) {
        messages.push((await installCi(memoryFs({}), pin, git)).message);
        messages.push((await installCi(memoryFs({ 'package.json': '{}' }), pin, git)).message);
        messages.push((await installDocsCi(memoryFs({}), pin, git)).message);
      }
    }
    messages.push(branchRuleSetting('trunk'));
    messages.push((await verifyBranchRule({ getJson: async () => null })).message);
    for (const message of messages) {
      expect(bareBarriers(message)).toEqual([]);
    }
  });

  it('the files that write workflows and install reports hold none, in strings or comments', async () => {
    for (const file of ['ci.ts', 'history-ci.ts', 'docs-ci.ts', 'workflow-branch.ts', 'repo-git.ts', 'branch-rule.ts', 'artifact-fetch.ts', 'build-run.ts', 'app-origin.ts', 'overlay.ts']) {
      const source = await readFile(new URL(`../../src/install/${file}`, import.meta.url), 'utf8');
      expect(bareBarriers(source), file).toEqual([]);
    }
  });
});
