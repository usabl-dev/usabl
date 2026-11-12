/**
 * The floor path and the empty floor live in one module, next to the floor parser, and every
 * reader of the floor takes them from there. The empty floor is the one `usabl baseline` would
 * write for an application with no accepted debt: no entries, at the current floor version.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_FLOOR, EVIDENCE_FLOOR_PATH, parseEvidenceFloor } from '../../src/evidence/floor.js';
import { EVIDENCE_FLOOR_PATH as BASELINE_FLOOR_PATH } from '../../src/baseline/index.js';
import { FLOOR_VERSION } from '../../src/primitives/identity.js';
import { floorHashOf } from '../../src/history/record.js';
import { recordMainScan } from '../../src/history/record-run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { UsablConfig } from '../../src/contracts/index.js';
import { COMMIT_B, scanOf } from '../history/helpers.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

describe('the floor defaults', () => {
  it('names the floor file once', () => {
    expect(EVIDENCE_FLOOR_PATH).toBe('.usabl-evidence.json');
    expect(BASELINE_FLOOR_PATH).toBe(EVIDENCE_FLOOR_PATH);
  });

  it('is an empty floor at the version usabl baseline writes, and parses as one', () => {
    expect(EMPTY_FLOOR).toEqual({ version: FLOOR_VERSION, entries: [] });
    expect(parseEvidenceFloor(JSON.parse(JSON.stringify(EMPTY_FLOOR)))).toEqual(EMPTY_FLOOR);
  });

  it('is the floor a history record of a run with no floor file was compared with', async () => {
    // No floor file. The page is listed so the scan of main has a screen to record.
    const files = { 'usabl.config.json': '{}', 'fixtures/app/src/ClustersPage.tsx': '' };
    const deps = makeFakeDeps({
      files,
      headContents: files,
      now: '2026-10-28T00:00:00.000Z',
      headRef: COMMIT_B,
      writeTree: 'e'.repeat(40),
      scans: { clusters: scanOf('clusters', []) },
    });

    const outcome = await recordMainScan(deps, config);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.record!.floorHash).toBe(floorHashOf(EMPTY_FLOOR));
  });
});
