/**
 * When a model-facing message is too long, a barrier is dropped whole: its headline outside the
 * frame and its pieces inside it go together. Pieces used to be dropped first and headlines last,
 * so a shortened message kept headlines such as "- barrier 30: [new serious]" whose rule, screen,
 * and fix were nowhere in the message. The note says how many barriers were left out, and the
 * show-all line counts only the barriers still shown.
 */
import { describe, expect, it } from 'vitest';
import type { Finding, Result, UsablConfig } from '../../src/contracts/index.js';
import { AGENT_MESSAGE_BUDGET, SELF_CHECK_MESSAGE_BUDGET } from '../../src/output/bounded-text.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { testConfig } from '../helpers.js';

const long = (seed: string): string => `${seed} ${'x'.repeat(2_000)}`;

function finding(index: number): Finding {
  return {
    rule: `rule-${index}`,
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: `screen-${index}`,
    elementPath: 'button',
    elementName: null,
    role: 'button',
    whatUserExperiences: long(`experience-${index}`),
    why: 'why',
    fix: long(`fix-${index}`),
    evidence: {},
    confidence: 'fail',
    elementKey: `k-${index}`,
    identityBasis: 'name',
    status: 'new',
    appSource: { tier: 'coverage', file: null, line: null, candidates: [long(`candidate-${index}`)] },
  };
}

function result(): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'regression',
    summary: 'regression: 40 blocking finding(s), 1 gap(s)',
    screens: [],
    coverage: {
      changedFiles: [],
      affected: [],
      unresolvedFiles: [],
      gaps: [{ ref: 'provider:pf-rulepack', state: 'capability-denied', reason: 'denied capability: network' }],
      nothingToCheck: false,
    },
    findings: Array.from({ length: 40 }, (_, index) => finding(index)),
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 1,
    accessibilityVerdict: 'regression',
    accessibilityExitCode: 1,
    paidDownCount: 0,
    floorHeadroom: [],
    floorUnconfirmed: [],
  };
}

const config: UsablConfig = { ...testConfig(), noiseBudget: { default: 40 } };

const surfaces = [
  { name: 'stop hook', budget: AGENT_MESSAGE_BUDGET, render: () => evaluateStopDecision(result(), { stopHookActive: false }, config).message },
  { name: 'self-check', budget: SELF_CHECK_MESSAGE_BUDGET, render: () => projectSelfCheck(result(), config).message },
];

for (const surface of surfaces) {
  describe(`${surface.name} shortened at a noise budget of 40`, () => {
    it('keeps every barrier headline with its rule, screen, and fix, and says how many were left out', () => {
      const message = surface.render();
      const headlines = [...message.matchAll(/^- barrier (\d+): \[new serious\]$/gm)].map((match) => match[1]!);

      expect(message.length).toBeLessThanOrEqual(surface.budget);
      expect(headlines.length).toBeGreaterThan(0);
      expect(headlines.length).toBeLessThan(40);
      for (const n of headlines) {
        expect(message).toMatch(new RegExp(`^barrier ${n}: axe/rule-\\d+$`, 'm'));
        expect(message).toMatch(new RegExp(`^screen \\(${n}\\): screen-\\d+$`, 'm'));
        expect(message).toMatch(new RegExp(`^fix \\(${n}\\): fix-\\d+ x+`, 'm'));
      }
      // No piece belongs to a barrier whose headline was left out.
      const pieceNumbers = [...message.matchAll(/^barrier (\d+): /gm)].map((match) => match[1]!);
      expect(pieceNumbers).toEqual(headlines);

      const left = 40 - headlines.length;
      expect(message).toContain(`${left} barrier(s) left out`);
      expect(message).toContain(`(${headlines.length} of 40 rule groups shown)`);
      // The gap is still disclosed: barriers go before the coverage lines do.
      expect(message).toContain('denied capability: network');
    });
  });
}
