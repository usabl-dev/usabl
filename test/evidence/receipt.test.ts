import { describe, it, expect } from 'vitest';
import { mintReceipt } from '../../src/evidence/receipt.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { canonicalHash } from '../../src/primitives/canonical.js';
import type { UsablConfig } from '../../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173', uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'x', wideBlastGlobs: [] }, surfaces: [],
  guardedPaths: ['usabl.config.json', 'src/gate'],
};

describe('mintReceipt', () => {
  it('binds source tree, policy hash, and runner version', async () => {
    const deps = makeFakeDeps({
      now: '2026-08-19T12:00:00.000Z', writeTree: 'tree-abc', runnerVersion: '0.0.0-test',
      headBlobs: { 'usabl.config.json': 'blob-1', 'src/gate': 'blob-2' },
    });
    const receipt = await mintReceipt(deps, config, {
      surfaces: ['cli'], checked: ['clusters'], notCovered: [],
      findingsSummary: { new: 0, carried: 1, fixed: 0, unverified: 0 }, activeWaivers: 0,
    });
    expect(receipt.verdict).toBe('verified');
    expect(receipt.sourceTree).toBe('tree-abc');
    expect(receipt.runnerVersion).toBe('0.0.0-test');
    expect(receipt.mintedAt).toBe('2026-08-19T12:00:00.000Z');
    expect(receipt.policyHash).toBe(canonicalHash([['src/gate', 'blob-2'], ['usabl.config.json', 'blob-1']]));
    expect(receipt.baseRevision).toBeNull();
  });
});
