/**
 * The engine's own checked-in gate, .github/workflows/usabl-gate.yml, is the usabl draft that
 * `usabl install --ci` writes, pinned to one full commit SHA. So this repository runs the same
 * judge split as every other repository, with an engine that the pull request cannot choose. The
 * generated gates are held to their six-job shape in gate-topology.test.ts. The pin moves only to a
 * commit on main, which CI checks with scripts/check-engine-pin.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECK } from '../../src/install/branch-rule.js';
import {
  REQUIRED_GATE_JOB,
  REQUIRED_GATE_SCRIPT,
  USABL_GATE_WORKFLOW,
  classifyGateWorkflow,
  matchWorkflow,
  pinEngineRef,
} from '../../src/install/ci.js';

const ENGINE_GATE = readFileSync(new URL('../../.github/workflows/usabl-gate.yml', import.meta.url), 'utf8');

describe("the engine's own gate", () => {
  it('is the usabl draft, wired', () => {
    expect(classifyGateWorkflow(ENGINE_GATE)).toBe('wired');
  });

  it('differs from the draft only at the engine pin, which is one full commit SHA', () => {
    const { state, ref } = matchWorkflow(ENGINE_GATE, USABL_GATE_WORKFLOW);
    expect(state).toBe('wired');
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(ENGINE_GATE).toBe(pinEngineRef(USABL_GATE_WORKFLOW, ref ?? ''));
  });

  it('runs the six-job judge split and the generated required rule', () => {
    const jobs = (load(ENGINE_GATE) as { jobs: Record<string, unknown> }).jobs;
    expect(Object.keys(jobs)).toEqual(['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', 'usabl-required']);
    expect(REQUIRED_GATE_JOB).toBe(REQUIRED_CHECK);
    expect(ENGINE_GATE).toContain(REQUIRED_GATE_SCRIPT.split('\n')[0]);
  });

  it('is checked in without the history workflow', () => {
    // This repository has no debt floor to track, and its package has no dev script for the
    // history scan to start, so the owner left the history workflow out.
    expect(existsSync(new URL('../../.github/workflows/usabl-history.yml', import.meta.url))).toBe(false);
  });
});
