/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Finding, Result, Verdict } from '../contracts/index.js';
import { frameUntrusted, scrubResult } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
}

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

function pickFinding(findings: Finding[]): Finding | null {
  const prioritized = findings.find((finding) => finding.status === 'new' || finding.status === 'carried');
  return prioritized ?? findings[0] ?? null;
}

function buildBlockMessage(result: Result): string {
  const lines = [`NOT verified - ${result.summary}`];
  const finding = pickFinding(result.findings);
  if (finding !== null) {
    lines.push(`Rule: ${finding.rule}`);
    lines.push(frameUntrusted(finding.whatUserExperiences));
  }
  return lines.join('\n');
}

export function evaluateStopDecision(result: Result, ctx: HookContext): StopDecision {
  const safe = scrubResult(result);

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    return {
      block: false,
      message:
        sourceTree === undefined
          ? 'verified: gate accepted this run.'
          : `verified: receipt sourceTree ${sourceTree}.`,
    };
  }

  if (safe.exitCode === 4) {
    return {
      block: false,
      message: `NOT verified - error during run. ${safe.summary}`,
    };
  }

  if (safe.verdict === null && safe.coverage.nothingToCheck) {
    return {
      block: false,
      message: 'nothing to check: no UI-touching files in this stop.',
    };
  }

  const shouldBlock = safe.verdict !== null && BLOCKING_VERDICTS.has(safe.verdict);
  if (!shouldBlock) {
    return {
      block: false,
      message: `NOT verified - ${safe.summary}`,
    };
  }

  if (ctx.stopHookActive) {
    // A second block while continuation is active can loop the model and hide the real operator choice.
    return {
      block: false,
      message: `NOT verified - continuation already active. ${safe.summary}`,
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe),
  };
}
