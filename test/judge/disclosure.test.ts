/**
 * The Result says when the trusted judge produced it: the browser was isolated, how many
 * requests it blocked, and which build digest it scanned. That block is disclosure only. It never
 * changes a verdict; a blocked request already shows as a coverage gap on its screen.
 */
import { describe, expect, it } from 'vitest';
import type { JudgeDisclosure, Result } from '../../src/contracts/index.js';
import { judgeDisclosure } from '../../src/judge/disclosure.js';
import { formatSummary } from '../../src/output/summary.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { parseResultJson } from '../../src/surfaces/policy-enforce.js';
import { scrubResult } from '../../src/surfaces/scrub.js';

const DIGEST = 'a'.repeat(64);

const baseResult = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
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
  floorUnconfirmed: [],
  ...over,
});

describe('judgeDisclosure', () => {
  it('records the isolated browser, the blocked count, and a well-formed build digest', () => {
    expect(judgeDisclosure(3, DIGEST)).toEqual({
      ok: true,
      judge: { isolatedBrowser: true, blockedRequests: 3, buildDigest: DIGEST },
    });
  });

  it('records no digest when none was given', () => {
    expect(judgeDisclosure(0, undefined)).toEqual({
      ok: true,
      judge: { isolatedBrowser: true, blockedRequests: 0, buildDigest: null },
    });
    expect(judgeDisclosure(0, '')).toEqual({
      ok: true,
      judge: { isolatedBrowser: true, blockedRequests: 0, buildDigest: null },
    });
  });

  it.each(['abc', 'A'.repeat(64), `${DIGEST}\n`, `${DIGEST} build.tar`, 'g'.repeat(64)])(
    'refuses a digest that is not 64 lowercase hex characters: %j',
    (digest) => {
      const outcome = judgeDisclosure(0, digest);
      expect(outcome.ok).toBe(false);
    },
  );
});

describe('the judge block on a Result', () => {
  const judged = baseResult({ judge: { isolatedBrowser: true, blockedRequests: 2, buildDigest: DIGEST } });

  it('survives the scrub that every projection runs first', () => {
    expect(scrubResult(judged).judge).toEqual({ isolatedBrowser: true, blockedRequests: 2, buildDigest: DIGEST });
  });

  it('is dropped by the scrub when its fields are not what the judge writes', () => {
    const forged = baseResult({
      judge: { isolatedBrowser: true, blockedRequests: 1.5, buildDigest: '<script>' } as unknown as JudgeDisclosure,
    });
    expect(scrubResult(forged).judge).toBeUndefined();
  });

  it('prints one line in the terminal summary', () => {
    const out = formatSummary(judged);
    expect(out).toContain('judge: isolated browser, 2 request(s) outside the allowed origins blocked');
    expect(out).toContain(`build sha256 ${DIGEST}`);
  });

  it('prints one line in the pull request comment', () => {
    const body = projectPrComment(judged);
    expect(body).toContain('Judge: isolated browser, 2 request(s) outside the allowed origins blocked');
    expect(body).toContain(DIGEST);
  });

  it('prints nothing about a judge when the Result has no judge block', () => {
    expect(formatSummary(baseResult())).not.toContain('judge:');
    expect(projectPrComment(baseResult())).not.toContain('Judge:');
  });

  it('is accepted by the Result parser when well formed and refused when not', () => {
    expect(parseResultJson(JSON.parse(JSON.stringify(judged))).judge?.blockedRequests).toBe(2);
    const bad = JSON.parse(JSON.stringify(judged));
    bad.judge.buildDigest = 'nope';
    expect(() => parseResultJson(bad)).toThrow(/judge/);
  });
});
