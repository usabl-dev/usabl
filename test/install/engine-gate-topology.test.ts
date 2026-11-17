/**
 * The engine's own checked-in gate, .github/workflows/usabl-gate.yml, is the gate that
 * `usabl install --ci` writes at the pinned commit, pinned to that commit. It is compared with the
 * draft in the pinned commit's own source, never with the draft in this tree. So a pull request
 * that changes the gate template merges with the gate untouched, and a later pull request that
 * moves the pin brings the new template in. The generated gates are held to their six-job shape in
 * gate-topology.test.ts. CI's engine-pin job runs the same comparison from trusted code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { draftGateAtPin } from '../../scripts/engine-pin-draft.js';
import { gateDraftProblem, readEnginePin } from '../../scripts/engine-pin.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENGINE_GATE = readFileSync(new URL('../../.github/workflows/usabl-gate.yml', import.meta.url), 'utf8');

function pinOf(gate: string): string {
  const pin = readEnginePin(gate);
  if ('problem' in pin) throw new Error(pin.problem);
  return pin.sha;
}

describe("the engine's own gate", () => {
  it('pins the engine to one full commit id', () => {
    expect(pinOf(ENGINE_GATE)).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
  });

  it('is byte for byte the gate usabl install --ci writes at the pinned commit', async () => {
    const pin = pinOf(ENGINE_GATE);
    const draft = await draftGateAtPin(pin, ROOT);
    expect(gateDraftProblem(ENGINE_GATE, draft, pin)).toBeNull();
  }, 120_000);

  it('runs the six-job judge split', () => {
    const jobs = (load(ENGINE_GATE) as { jobs: Record<string, unknown> }).jobs;
    expect(Object.keys(jobs)).toEqual(['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', 'usabl-required']);
  });

  it('fails with a plain message, never a pass, when the pin commit is not in the clone', async () => {
    await expect(draftGateAtPin('f'.repeat(40), ROOT)).rejects.toThrow(
      `usabl engine pin: commit ${'f'.repeat(40)} is not in this clone, so the gate cannot be compared with the draft that commit writes. Fetch the full history of main and run the check again.`,
    );
  });

  it('is checked in without the history workflow', () => {
    // This repository has no debt floor to track, and its package has no dev script for the
    // history scan to start, so the owner left the history workflow out.
    expect(existsSync(new URL('../../.github/workflows/usabl-history.yml', import.meta.url))).toBe(false);
  });
});
