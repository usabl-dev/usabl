/**
 * The pull request comment and the Stop hook show the changed files the planner left out on
 * purpose, as the terminal does, so a reviewer sees what was skipped. An idle run that excluded
 * files lists them and does not read as plain "nothing to check". In the comment the list is
 * low-priority detail: near the size bound it is cut before any gap or finding, with a count.
 */
import { describe, expect, it } from 'vitest';
import type { ExcludedFile, Finding, Result } from '../../src/contracts/index.js';
import { projectPrComment, projectPrCommentWithin } from '../../src/surfaces/pr-comment.js';
import { UNTRUSTED_FRAME_END, UNTRUSTED_FRAME_START } from '../../src/surfaces/scrub.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';

const REASON =
  'This file is in a test folder (test, tests, or __tests__). usabl found no import of it in any file outside the tests, and no import usabl could not follow could load it, so usabl reads it as test code and did not check it.';
const EXCLUDED: ExcludedFile = { ref: 'src/tests/setup.ts', reason: REASON };

const result = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: null,
  summary: 'nothing to check',
  screens: [],
  coverage: { changedFiles: ['src/tests/setup.ts'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
  ...over,
});

const idle = (excludedFiles: ExcludedFile[]): Result =>
  result({ coverage: { changedFiles: excludedFiles.map((entry) => entry.ref), affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true, excludedFiles } });

const finding = (over: Partial<Finding>): Finding => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button#submit',
  elementName: 'Submit',
  role: 'button',
  whatUserExperiences: 'Low contrast text on the submit button makes the label hard to read.',
  why: 'Element has insufficient color contrast.',
  fix: 'Raise the contrast of the label.',
  evidence: {},
  confidence: 'fail',
  elementKey: 'k-submit',
  identityBasis: 'name',
  status: 'new',
  ...over,
});

describe('the pull request comment', () => {
  it('lists the excluded file of an idle run and says files were left out', () => {
    const markdown = projectPrComment(idle([EXCLUDED]));
    expect(markdown).toContain('### Excluded files, not checked');
    expect(markdown).toContain('usabl left out 1 changed file on purpose');
    expect(markdown).toContain('file: `src/tests/setup.ts`');
    expect(markdown).toContain('why: `This file is in a test folder');
    // The list sits inside one untrusted frame.
    const start = markdown.indexOf(UNTRUSTED_FRAME_START);
    expect(start).toBeGreaterThan(markdown.indexOf('### Excluded files, not checked'));
    expect(markdown.indexOf(UNTRUSTED_FRAME_END)).toBeGreaterThan(markdown.indexOf('file: `src/tests/setup.ts`'));
  });

  it('keeps an idle run with nothing excluded as it was', () => {
    const markdown = projectPrComment(idle([]));
    expect(markdown).not.toContain('Excluded files');
    expect(markdown).not.toContain('left out');
  });

  it('names twenty files and counts the rest', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ ref: `src/tests/helper-${String(index).padStart(2, '0')}.ts`, reason: REASON }));
    const markdown = projectPrComment(idle(many));
    expect(markdown).toContain('usabl left out 25 changed files on purpose');
    expect(markdown.match(/^file: /gmu)).toHaveLength(20);
    expect(markdown).toContain('5 more excluded files are not shown.');
  });

  it('seals a file name that carries markup in a code span', () => {
    const markdown = projectPrComment(idle([{ ref: 'src/tests/[x](https://example.test).ts', reason: 'see @someone' }]));
    expect(markdown).toContain('file: `src/tests/[x](https://example.test).ts`');
    expect(markdown).toContain('why: `see @someone`');
  });

  it('lists excluded files under a verdict after the coverage gaps', () => {
    const markdown = projectPrComment(
      result({
        verdict: 'not_covered',
        exitCode: 3,
        coverage: {
          changedFiles: [],
          affected: [],
          unresolvedFiles: ['src/Other.tsx'],
          gaps: [{ ref: 'src/Other.tsx', state: 'unresolved', reason: 'no route reaches it' }],
          nothingToCheck: false,
          excludedFiles: [EXCLUDED],
        },
      }),
    );
    expect(markdown).toContain('### Excluded files, not checked');
    expect(markdown.indexOf('### Excluded files, not checked')).toBeGreaterThan(markdown.indexOf('### Coverage gaps'));
    expect(markdown).toContain('file: `src/tests/setup.ts`');
  });

  it('cuts excluded files before any gap or finding near its size bound, and counts them', () => {
    // Fifteen groups with a long reason each, so the list is longer than the room the cut reserves.
    const excludedFiles = Array.from({ length: 15 }, (_, index) => ({
      ref: `src/tests/helper-${String(index).padStart(2, '0')}.ts`,
      reason: `${String(index).padStart(2, '0')} ${REASON}`,
    }));
    const near = result({
      verdict: 'regression',
      exitCode: 1,
      findings: [finding({ rule: 'gate-0' }), finding({ rule: 'adv-0', elementKey: 'a0', evidenceClass: 'preview' })],
      coverage: {
        changedFiles: [],
        affected: [],
        unresolvedFiles: [],
        gaps: [
          { ref: 'gap-0', state: 'unresolved', reason: 'no route reaches it' },
          { ref: 'gap-1', state: 'unresolved', reason: 'no route reaches it' },
        ],
        nothingToCheck: false,
        excludedFiles,
      },
    });
    const whole = projectPrCommentWithin(near, undefined, Number.MAX_SAFE_INTEGER);
    expect(whole).toContain('file: `src/tests/helper-14.ts`');
    // Just under the whole body: excluded files go from the end, and nothing else does.
    const markdown = projectPrCommentWithin(near, undefined, whole.length - 200);
    expect(markdown).not.toContain('file: `src/tests/helper-14.ts`');
    expect(markdown).toMatch(/^- \d+ more groups? of excluded files not shown here/mu);
    expect(markdown).toContain('ref: `gap-1`');
    expect(markdown).toContain('`axe/adv-0`');
    expect(markdown).toContain('`axe/gate-0`');
  });
});

describe('the Stop hook', () => {
  it('lists the excluded file of an idle run, inside the frame, and lets the stop through', () => {
    const decision = evaluateStopDecision(idle([EXCLUDED]), { stopHookActive: false });
    expect(decision.block).toBe(false);
    const [first] = decision.message.split('\n');
    expect(first).toContain('usabl left out 1 changed file on purpose');
    expect(first).toContain('You may stop.');
    const frame = decision.message.slice(decision.message.indexOf(UNTRUSTED_FRAME_START));
    expect(frame).toContain('excluded, not checked: src/tests/setup.ts');
    expect(frame).toContain('why: This file is in a test folder');
  });

  it('keeps an idle run with nothing excluded as one line', () => {
    const decision = evaluateStopDecision(idle([]), { stopHookActive: false });
    expect(decision.message.split('\n')).toHaveLength(1);
    expect(decision.message).not.toContain('left out');
  });

  it('lists excluded files beside a verified run', () => {
    const decision = evaluateStopDecision(
      result({
        verdict: 'verified',
        coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false, excludedFiles: [EXCLUDED] },
      }),
      { stopHookActive: false },
    );
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('excluded, not checked: src/tests/setup.ts');
  });

  it('lists excluded files in a block message', () => {
    const decision = evaluateStopDecision(
      result({
        verdict: 'regression',
        exitCode: 1,
        findings: [finding({})],
        coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false, excludedFiles: [EXCLUDED] },
      }),
      { stopHookActive: false },
    );
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('excluded, not checked: src/tests/setup.ts');
  });
});
