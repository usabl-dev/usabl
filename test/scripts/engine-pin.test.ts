/**
 * This repository's own gate checks out the engine at a pinned commit. CI's engine-pin job runs
 * scripts/check-engine-pin.ts from the trusted commit and reads the pull request's gate only as
 * data. It stops a pin that is not a commit on main, a pin that moves back, and a gate that is not
 * the draft of the pinned commit. These tests hold the rule that reads the pin, the rule that
 * judges it, and the git call that decides ancestry.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enginePinProblem, gateDraftProblem, gitIsAncestor, readEnginePin, readGitFile, type Ancestry } from '../../scripts/engine-pin.js';
import { ENGINE_REF_PLACEHOLDER, USABL_GATE_WORKFLOW, pinEngineRef } from '../../src/install/ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OLDER = '89abcdef0123456789abcdef0123456789abcdef';
const PINNED = pinEngineRef(USABL_GATE_WORKFLOW, SHA);
const ENGINE_REF = `          repository: usabl-dev/usabl\n          ref: ${SHA}\n`;

// The gate with one more step at the start of the usabl-engine job.
function withStep(step: string): string {
  return PINNED.replace('    steps:\n', `    steps:\n${step}`);
}

function checkout(inputs: string): string {
  return `      - name: Another checkout\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n        with:\n${inputs}`;
}

describe('readEnginePin', () => {
  it('reads the one engine checkout ref from the generated gate', () => {
    expect(readEnginePin(PINNED)).toEqual({ sha: SHA });
  });

  it('accepts a full 64-character commit id', () => {
    const long = 'a'.repeat(64);
    expect(readEnginePin(PINNED.replace(`ref: ${SHA}`, `ref: ${long}`))).toEqual({ sha: long });
  });

  it('refuses the placeholder, a short or uppercase id, a branch name, and an expression', () => {
    expect(readEnginePin(USABL_GATE_WORKFLOW)).toEqual({ problem: expect.stringContaining(ENGINE_REF_PLACEHOLDER) });
    for (const ref of [SHA.slice(0, 7), SHA.toUpperCase(), 'release-line', `${SHA}0`, "'${{ github.sha }}'"]) {
      const pin = readEnginePin(PINNED.replace(`ref: ${SHA}`, `ref: ${ref}`));
      expect(pin, ref).toEqual({ problem: expect.stringContaining('not a full lowercase commit id') });
      // Only a value that matched the commit id rule is printed, so the pull request cannot print
      // text of its choice through the message.
      expect('problem' in pin && pin.problem.includes(ref), ref).toBe(false);
    }
  });

  it('refuses a workflow with no engine checkout', () => {
    const none = PINNED.replace('repository: usabl-dev/usabl', 'repository: someone/else');
    expect(readEnginePin(none)).toEqual({ problem: expect.stringContaining('no step that can check out the engine') });
  });

  it('counts every step that could check out the engine, and refuses more than one', () => {
    const second: Record<string, string> = {
      'the same name': checkout(ENGINE_REF),
      'the name in another case': checkout(`          repository: Usabl-Dev/USABL\n          ref: ${SHA}\n`),
      'the name with .git': checkout(`          repository: usabl-dev/usabl.git\n          ref: ${SHA}\n`),
      'a repository expression': checkout(`          repository: \${{ github.repository }}\n          ref: ${SHA}\n`),
      'no repository and a fixed ref': checkout(`          ref: ${SHA}\n`),
      'no repository and no ref': '      - name: Another checkout\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n',
      'no repository and another expression': checkout('          ref: ${{ github.sha }}\n'),
      'another action that names the engine': `      - name: Another clone\n        uses: some/clone@v1\n        with:\n${ENGINE_REF}`,
      'checkout in another case': `      - name: Another checkout\n        uses: Actions/Checkout@v5\n        with:\n          ref: ${SHA}\n`,
    };
    for (const [what, step] of Object.entries(second)) {
      expect(readEnginePin(withStep(step)), what).toEqual({ problem: expect.stringContaining('2 steps that can check out the engine') });
    }
  });

  it('does not count the checkouts of the pull request head and base commits', () => {
    for (const ref of ['${{ github.event.pull_request.head.sha }}', '${{ github.event.pull_request.base.sha }}']) {
      expect(readEnginePin(withStep(checkout(`          ref: ${ref}\n`))), ref).toEqual({ sha: SHA });
    }
  });

  it('refuses text that is not a workflow', () => {
    for (const raw of ['', 'not: [closed', '[]', 'jobs: 3']) {
      expect(readEnginePin(raw), raw).toHaveProperty('problem');
    }
  });
});

describe('enginePinProblem', () => {
  // Answers by pair, so each test says which question got which answer.
  function ancestry(answers: Record<string, Ancestry>): (older: string, newer: string) => Ancestry {
    return (older, newer) => answers[`${older} ${newer}`] ?? 'unreadable';
  }
  const onMain = { [`${SHA} origin/main`]: 'ancestor' } as const;

  it('passes a pin on main when there is no base to compare with', () => {
    expect(enginePinProblem({ headGate: PINNED, baseGate: null, mainRef: 'origin/main', isAncestor: ancestry(onMain) })).toBeNull();
  });

  it('stops a pin that is not on main, and says the rule', () => {
    const problem = enginePinProblem({ headGate: PINNED, baseGate: null, mainRef: 'origin/main', isAncestor: ancestry({ [`${SHA} origin/main`]: 'not-ancestor' }) });
    expect(problem).toBe(
      `usabl engine pin: the gate pins the engine to ${SHA}, which is not a commit on origin/main. The pin may move only to a commit on main. Build usabl from a clean checkout of a main commit, run usabl install --ci there, and copy the gate in.`,
    );
  });

  it('stops when git cannot tell, and never reads that as a pass', () => {
    expect(enginePinProblem({ headGate: PINNED, baseGate: null, mainRef: 'origin/main', isAncestor: ancestry({}) })).toBe(
      `usabl engine pin: git could not tell whether ${SHA} is a commit on origin/main, because a commit or the branch is not in this checkout. Fetch the full history of main and run the check again.`,
    );
  });

  it('passes a pin that stays the same as the base pin', () => {
    expect(enginePinProblem({ headGate: PINNED, baseGate: PINNED, mainRef: 'origin/main', isAncestor: ancestry(onMain) })).toBeNull();
  });

  it('passes a pin that moves forward from the base pin', () => {
    const base = pinEngineRef(USABL_GATE_WORKFLOW, OLDER);
    const answers = { ...onMain, [`${OLDER} ${SHA}`]: 'ancestor' } as const;
    expect(enginePinProblem({ headGate: PINNED, baseGate: base, mainRef: 'origin/main', isAncestor: ancestry(answers) })).toBeNull();
  });

  it('stops a pin that moves back or sideways from the base pin', () => {
    const base = pinEngineRef(USABL_GATE_WORKFLOW, OLDER);
    const answers = { ...onMain, [`${OLDER} ${SHA}`]: 'not-ancestor' } as const;
    expect(enginePinProblem({ headGate: PINNED, baseGate: base, mainRef: 'origin/main', isAncestor: ancestry(answers) })).toBe(
      `usabl engine pin: the gate moves the engine pin from ${OLDER} to ${SHA}, which does not descend from it. The pin never moves back: pin a main commit that comes after ${OLDER}.`,
    );
  });

  it('stops when git cannot tell whether the pin moved back', () => {
    const base = pinEngineRef(USABL_GATE_WORKFLOW, OLDER);
    expect(enginePinProblem({ headGate: PINNED, baseGate: base, mainRef: 'origin/main', isAncestor: ancestry(onMain) })).toContain(
      `git could not tell whether ${SHA} comes after ${OLDER}`,
    );
  });

  it('stops when the base gate holds no pin it can read', () => {
    const problem = enginePinProblem({ headGate: PINNED, baseGate: 'name: other\n', mainRef: 'origin/main', isAncestor: ancestry(onMain) });
    expect(problem).toContain('the gate at the base commit holds no engine pin');
  });

  it('stops a placeholder before it asks git', () => {
    let asked = false;
    const problem = enginePinProblem({
      headGate: USABL_GATE_WORKFLOW,
      baseGate: null,
      mainRef: 'origin/main',
      isAncestor: () => {
        asked = true;
        return 'ancestor';
      },
    });
    expect(problem).toContain(ENGINE_REF_PLACEHOLDER);
    expect(asked).toBe(false);
  });
});

describe('gateDraftProblem', () => {
  it('passes a gate that is the draft byte for byte', () => {
    expect(gateDraftProblem(PINNED, PINNED, SHA)).toBeNull();
  });

  it('names the first line that differs from the draft at the pin', () => {
    const edited = PINNED.replace('    steps:\n', '    steps:\n      - run: echo extra\n');
    const line = PINNED.split('\n').indexOf('    steps:') + 2;
    expect(gateDraftProblem(edited, PINNED, SHA)).toBe(
      `usabl engine pin: .github/workflows/usabl-gate.yml is not the gate usabl install --ci writes at the pinned commit ${SHA}. The first difference is at line ${line}. Build usabl from a clean checkout of that commit, run usabl install --ci there, and copy the gate in.`,
    );
  });

  it('refuses a gate that only adds a final newline', () => {
    expect(gateDraftProblem(`${PINNED}\n`, PINNED, SHA)).not.toBeNull();
  });
});

describe('git readers', () => {
  let repo = '';

  afterEach(() => {
    if (repo !== '') rmSync(repo, { recursive: true, force: true });
    repo = '';
  });

  function git(...args: string[]): string {
    const out = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim();
  }

  function commit(name: string): string {
    writeFileSync(join(repo, name), name);
    git('add', name);
    git('commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  }

  it('reads ancestry from real git, and an unknown commit or branch as unreadable', () => {
    repo = mkdtempSync(join(tmpdir(), 'usabl-engine-pin-'));
    git('init', '--quiet', '--initial-branch=main');
    const first = commit('a');
    const second = commit('b');
    git('switch', '--quiet', '-c', 'side', first);
    const side = commit('c');

    expect(gitIsAncestor(second, 'main', repo)).toBe('ancestor');
    expect(gitIsAncestor(first, 'main', repo)).toBe('ancestor');
    expect(gitIsAncestor(first, second, repo)).toBe('ancestor');
    expect(gitIsAncestor(second, first, repo)).toBe('not-ancestor');
    expect(gitIsAncestor(side, 'main', repo)).toBe('not-ancestor');
    expect(gitIsAncestor('f'.repeat(40), 'main', repo)).toBe('unreadable');
    expect(gitIsAncestor(second, 'no-such-branch', repo)).toBe('unreadable');
  });

  it('reads a file at a commit as data, and a missing file or commit as null', () => {
    repo = mkdtempSync(join(tmpdir(), 'usabl-engine-pin-'));
    git('init', '--quiet', '--initial-branch=main');
    const first = commit('a');

    expect(readGitFile(first, 'a', repo)).toBe('a');
    expect(readGitFile(first, 'missing', repo)).toBeNull();
    expect(readGitFile('f'.repeat(40), 'a', repo)).toBeNull();
  });
});
