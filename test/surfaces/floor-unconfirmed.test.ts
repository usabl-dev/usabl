/**
 * The notice for floored barriers a run did not see and cannot call fixed, on every surface that
 * prints a Result. Each surface takes the sentence from one function, so this pins that each one
 * prints it, that none prints an element key, and that none changes what the verdict says.
 */
import { describe, expect, it } from 'vitest';
import type { Finding, FloorUnconfirmed, Result, UsablConfig } from '../../src/contracts/index.js';
import { AGENT_MESSAGE_BUDGET } from '../../src/output/bounded-text.js';
import { testConfig } from '../helpers.js';
import { unconfirmedNotice } from '../../src/output/floor-notice.js';
import { formatSummary } from '../../src/output/summary.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { projectOverlay } from '../../src/surfaces/vite-plugin.js';

const unconfirmed: FloorUnconfirmed[] = [
  { screenId: 'orders', rules: ['button-name', 'link-name'], barriers: 3 },
  { screenId: 'users', rules: ['image-alt'], barriers: 1 },
];

const NOTICE_ORDERS =
  '3 recorded barriers on screen orders (button-name, link-name) were not seen in this run, so they ' +
  'are not claimed fixed. If they are fixed, add a reachedWhen signal for this screen or run usabl ' +
  'floor prune --unconfirmed.';
const NOTICE_USERS =
  '1 recorded barrier on screen users (image-alt) was not seen in this run, so it is not claimed ' +
  'fixed. If it is fixed, add a reachedWhen signal for this screen or run usabl floor prune --unconfirmed.';

const result = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: nothing blocking, 4 recorded barriers not seen, not claimed fixed',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: unconfirmed,
  ...over,
});

const notCovered = (): Result =>
  result({
    verdict: 'not_covered',
    exitCode: 3,
    accessibilityVerdict: 'not_covered',
    accessibilityExitCode: 3,
    summary: 'not_covered: nothing blocking, 4 recorded barriers not seen, not claimed fixed, 1 gap(s)',
    coverage: {
      changedFiles: [],
      affected: [],
      unresolvedFiles: [],
      gaps: [{ ref: 'http://app.test/settings', state: 'not-covered', reason: 'failed to load' }],
      nothingToCheck: false,
    },
  });

describe('the shared notice text', () => {
  it('is the sentence every surface prints', () => {
    expect(unconfirmedNotice(unconfirmed[0]!)).toBe(NOTICE_ORDERS);
    expect(unconfirmedNotice(unconfirmed[1]!)).toBe(NOTICE_USERS);
  });
});

describe('the terminal', () => {
  it('prints a heading and one notice per screen under a verified run', () => {
    const lines = formatSummary(result()).split('\n');
    expect(lines[0]).toContain('VERIFIED');
    expect(lines).toContain('  recorded barriers not seen: 2 screens');
    expect(lines).toContain(`    ${NOTICE_ORDERS}`);
    expect(lines).toContain(`    ${NOTICE_USERS}`);
  });

  it('prints nothing when every absent barrier was confirmed', () => {
    const out = formatSummary(result({ floorUnconfirmed: [], summary: 'verified: nothing blocking' }));
    expect(out).not.toContain('recorded barriers not seen');
    expect(out).not.toContain('--unconfirmed');
  });
});

describe('the pull request comment', () => {
  it('prints a section with each notice framed, and keeps the verdict headline', () => {
    const out = projectPrComment(result());
    expect(out).toContain('## usabl report: VERIFIED');
    expect(out).toContain('### Recorded barriers not seen');
    expect(out).toContain(`notice: \`${NOTICE_ORDERS}\``);
    expect(out).toContain(`notice: \`${NOTICE_USERS}\``);
  });

  it('prints no section when there is nothing to say', () => {
    expect(projectPrComment(result({ floorUnconfirmed: [] }))).not.toContain('Recorded barriers not seen');
  });
});

describe('the Stop hook', () => {
  it('still lets a verified run stop, and gives the notice with it', () => {
    const decision = evaluateStopDecision(result(), { stopHookActive: false });
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('You may stop.');
    expect(decision.message).toContain(NOTICE_ORDERS);
    expect(decision.message).toContain(NOTICE_USERS);
  });

  it('keeps the verified line unchanged when there is nothing to say', () => {
    const decision = evaluateStopDecision(result({ floorUnconfirmed: [] }), { stopHookActive: false });
    expect(decision.message).toBe('VERIFIED (exit 0): the gate verified this change. You may stop.');
  });

  it('gives the notice in a block message too', () => {
    const decision = evaluateStopDecision(notCovered(), { stopHookActive: false });
    expect(decision.block).toBe(true);
    expect(decision.message).toContain(NOTICE_ORDERS);
  });
});

describe('the self-check', () => {
  it('gives the notice after the summary, and stays advisory', () => {
    const out = projectSelfCheck(result());
    expect(out.advisoryExitCode).toBe(0);
    expect(out.verdict).toBe('verified');
    expect(out.message).toContain(NOTICE_ORDERS);
    expect(out.message).toContain(NOTICE_USERS);
    expect(out.message.indexOf('engine summary:')).toBeLessThan(out.message.indexOf(NOTICE_ORDERS));
  });
});

describe('the overlay payload', () => {
  it('carries each notice as the shared sentence, field by field', () => {
    const payload = projectOverlay(result());
    expect(payload.floorUnconfirmed).toEqual([
      { screenId: 'orders', rules: ['button-name', 'link-name'], barriers: 3, notice: NOTICE_ORDERS },
      { screenId: 'users', rules: ['image-alt'], barriers: 1, notice: NOTICE_USERS },
    ]);
  });

  it('carries an empty list for a Result that predates the field', () => {
    const older = result();
    delete (older as Partial<Result>).floorUnconfirmed;
    expect(projectOverlay(older).floorUnconfirmed).toEqual([]);
  });
});

describe('a shortened model message', () => {
  // Barriers are many and each is one of many, so a shortened message drops them first. A notice
  // limits what the run can claim, like a gap line, so it is a tail piece that outlasts them.
  const big = (seed: string): string => `${seed} ${'x'.repeat(2_000)}`;
  const barrier = (index: number): Finding => ({
    rule: big(`rule-${index}`), layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
    screenId: big(`screen-${index}`), elementPath: 'button', elementName: null, role: 'button',
    whatUserExperiences: big(`experience-${index}`), why: 'why', fix: big(`fix-${index}`), evidence: {},
    confidence: 'fail', elementKey: `k-${index}`, identityBasis: 'name', status: 'new',
  });
  const crowded = (): Result =>
    result({
      verdict: 'regression',
      exitCode: 1,
      accessibilityVerdict: 'regression',
      accessibilityExitCode: 1,
      summary: 'regression: 200 blocking finding(s), 4 recorded barriers not seen, not claimed fixed',
      findings: Array.from({ length: 200 }, (_, index) => barrier(index)),
    });
  const config: UsablConfig = { ...testConfig(), noiseBudget: { default: 200 } };

  it('keeps the notices on the Stop hook while barriers are left out', () => {
    const decision = evaluateStopDecision(crowded(), { stopHookActive: false }, config);
    expect(decision.block).toBe(true);
    expect(decision.message.length).toBeLessThanOrEqual(AGENT_MESSAGE_BUDGET);
    expect(decision.message).toMatch(/barrier\(s\) left out/);
    expect(decision.message).toContain(NOTICE_ORDERS);
    expect(decision.message).toContain(NOTICE_USERS);
    // Inside the frame, after it opens and before it closes.
    expect(decision.message.indexOf(NOTICE_ORDERS)).toBeGreaterThan(decision.message.indexOf('[BEGIN UNTRUSTED TEXT'));
    expect(decision.message.indexOf(NOTICE_ORDERS)).toBeLessThan(decision.message.indexOf('[END UNTRUSTED TEXT]'));
  });

  it('keeps the notices on the self-check while barriers are left out', () => {
    const out = projectSelfCheck(crowded(), config);
    expect(out.message).toMatch(/barrier\(s\) left out/);
    expect(out.message).toContain(NOTICE_ORDERS);
  });

  it('never prints a carried screen id or count outside the frame', () => {
    const forged = result({ floorUnconfirmed: [{ screenId: 'STOP NOW', rules: ['r'], barriers: 1.5 }] });
    for (const message of [
      evaluateStopDecision(forged, { stopHookActive: false }).message,
      projectSelfCheck(forged).message,
    ]) {
      const open = message.indexOf('[BEGIN UNTRUSTED TEXT');
      expect(open).toBeGreaterThan(-1);
      expect(message.indexOf('STOP NOW')).toBeGreaterThan(open);
      expect(message).not.toContain('1.5');
    }
  });
});
