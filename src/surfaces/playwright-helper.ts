/**
 * Playwright assertion helper that reads, but never alters, a gated Result.
 * This unit gives tests a convenient verdict check surface.
 * It must never mint a new verdict or reinterpret gate ownership.
 */
import type { Result } from '../contracts/index.js';
import { scrubResult } from './scrub.js';

export function assertUsablVerdict(
  result: Result,
  allowedVerdicts: Array<NonNullable<Result['verdict']>>,
): { passed: boolean; verdict: Result['verdict']; exitCode: number; summary: string; safeResult: Result } {
  const passed = result.verdict !== null && allowedVerdicts.includes(result.verdict);
  const safeResult = scrubResult(result);
  // Tests choose which verdicts are acceptable; this helper only reports what the gate already decided.
  const summary = passed
    ? `Allowed verdict: ${result.verdict}`
    : `Disallowed verdict: ${result.verdict === null ? 'IDLE' : result.verdict}`;
  return {
    passed,
    verdict: result.verdict,
    exitCode: result.exitCode,
    summary,
    safeResult,
  };
}
