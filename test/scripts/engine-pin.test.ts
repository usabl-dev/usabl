/**
 * This repository's own gate checks out the engine at a pinned commit. CI runs
 * scripts/check-engine-pin.ts to stop a pin that is not a commit on main, because the self gate must
 * judge with engine code that main has held. These tests hold the rule that reads the pin and the
 * git call that decides ancestry.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enginePinProblem, gitAncestry, readEnginePin, type Ancestry } from '../../scripts/engine-pin.js';
import { ENGINE_REF_PLACEHOLDER, USABL_GATE_WORKFLOW, pinEngineRef } from '../../src/install/ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PINNED = pinEngineRef(USABL_GATE_WORKFLOW, SHA);
const always = (answer: Ancestry) => (): Ancestry => answer;

describe('readEnginePin', () => {
  it('reads the one engine checkout ref from the generated gate', () => {
    expect(readEnginePin(PINNED)).toEqual({ sha: SHA });
  });

  it('reads the checked-in gate as pinned to one full commit SHA', () => {
    const raw = readFileSync(new URL('../../.github/workflows/usabl-gate.yml', import.meta.url), 'utf8');
    const pin = readEnginePin(raw);
    expect('sha' in pin && /^[0-9a-f]{40}$/.test(pin.sha)).toBe(true);
  });

  it('refuses the placeholder, a short or uppercase SHA, and a branch name', () => {
    expect(readEnginePin(USABL_GATE_WORKFLOW)).toEqual({ problem: expect.stringContaining(ENGINE_REF_PLACEHOLDER) });
    for (const ref of [SHA.slice(0, 7), SHA.toUpperCase(), 'release-line', `${SHA}0`]) {
      const raw = PINNED.replace(`ref: ${SHA}`, `ref: ${ref}`);
      const pin = readEnginePin(raw);
      expect(pin, ref).toEqual({ problem: expect.stringContaining('not a full 40-character lowercase commit SHA') });
      // The value is not echoed, so a pull request cannot print text of its choice through it.
      expect('problem' in pin && pin.problem.includes(ref)).toBe(false);
    }
  });

  it('refuses a workflow with no engine checkout or with two', () => {
    const none = PINNED.replace('repository: usabl-dev/usabl', 'repository: someone/else');
    expect(readEnginePin(none)).toEqual({ problem: expect.stringContaining('no step that checks out usabl-dev/usabl') });
    const step = '      - name: Second engine checkout\n        uses: actions/checkout@v5\n        with:\n          repository: usabl-dev/usabl\n          ref: main\n';
    const two = PINNED.replace('    steps:\n', `    steps:\n${step}`);
    expect(readEnginePin(two)).toEqual({ problem: expect.stringContaining('2 steps that check out usabl-dev/usabl') });
  });

  it('refuses text that is not a workflow', () => {
    for (const raw of ['', 'not: [closed', '[]', 'jobs: 3']) {
      expect(readEnginePin(raw), raw).toHaveProperty('problem');
    }
  });
});

describe('enginePinProblem', () => {
  it('passes a pin that is a commit on main', () => {
    expect(enginePinProblem(PINNED, always('on-main'), 'origin/main')).toBeNull();
  });

  it('stops a pin that is not on main, and says the rule', () => {
    expect(enginePinProblem(PINNED, always('not-on-main'), 'origin/main')).toBe(
      `usabl engine pin: the gate pins the engine to ${SHA}, which is not a commit on origin/main. The pin may move only to a commit on main. Build usabl from a clean checkout of a main commit, run usabl install --ci there, and copy the gate in.`,
    );
  });

  it('stops when git cannot tell, and never reads that as a pass', () => {
    expect(enginePinProblem(PINNED, always('unreadable'), 'origin/main')).toBe(
      `usabl engine pin: git could not tell whether ${SHA} is a commit on origin/main, because the commit or the branch is not in this checkout. Fetch the full history of main and run the check again.`,
    );
  });

  it('stops a placeholder before it asks git', () => {
    let asked = false;
    const problem = enginePinProblem(USABL_GATE_WORKFLOW, () => {
      asked = true;
      return 'on-main';
    }, 'origin/main');
    expect(problem).toContain(ENGINE_REF_PLACEHOLDER);
    expect(asked).toBe(false);
  });
});

describe('gitAncestry', () => {
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

  it('reads on main, not on main, and an unknown commit from real git', () => {
    repo = mkdtempSync(join(tmpdir(), 'usabl-engine-pin-'));
    git('init', '--quiet', '--initial-branch=main');
    const first = commit('a');
    const onMain = commit('b');
    git('switch', '--quiet', '-c', 'side', first);
    const side = commit('c');

    expect(gitAncestry(onMain, 'main', repo)).toBe('on-main');
    expect(gitAncestry(first, 'main', repo)).toBe('on-main');
    expect(gitAncestry(side, 'main', repo)).toBe('not-on-main');
    expect(gitAncestry('f'.repeat(40), 'main', repo)).toBe('unreadable');
    expect(gitAncestry(onMain, 'no-such-branch', repo)).toBe('unreadable');
  });
});
