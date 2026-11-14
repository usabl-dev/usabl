import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { verifyReceipt } from '../src/evidence/receipt.js';
import { run } from '../src/run.js';

// Run level: the receipt run() mints records the starting commit its changed list was taken
// from, and a receipt for another starting commit does not verify.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const BASE = '1'.repeat(40);
const OTHER_BASE = '2'.repeat(40);

function deps() {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
  };
  return makeFakeDeps({ files, headContents: { ...files } });
}

describe('run binds the starting commit into the receipt', () => {
  it('records the starting commit it was given and verifies only for that commit', async () => {
    const result = await run(deps(), config, {
      changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
      baseRevision: BASE,
    });

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.baseRevision).toBe(BASE);
    const receipt = result.receipt!;
    await expect(verifyReceipt(deps(), config, receipt, receipt.sourceTree, BASE)).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
    await expect(verifyReceipt(deps(), config, receipt, receipt.sourceTree, OTHER_BASE)).resolves.toEqual({
      valid: false,
      failedFields: ['baseRevision'],
    });
  });

  // run() lists only the uncommitted changes when it gets no list, so a starting commit given
  // without one is not where its changes came from, and the receipt must not claim it.
  it('records no starting commit when it was given one but no changed list', async () => {
    const files = {
      'usabl.config.json': JSON.stringify(config),
      'usabl.routes.json': JSON.stringify({ routes: [] }),
    };
    const uncommitted = makeFakeDeps({
      files,
      headContents: { ...files },
      changed: [{ path: 'fixtures/app/src/ClustersPage.tsx', code: ' M' }],
    });
    const result = await run(uncommitted, config, { baseRevision: BASE });
    expect(result.verdict).toBe('verified');
    expect(result.receipt?.baseRevision).toBeNull();
  });

  it('records no starting commit when it was given none', async () => {
    const result = await run(deps(), config, { changedFiles: ['fixtures/app/src/ClustersPage.tsx'] });
    expect(result.verdict).toBe('verified');
    expect(result.receipt?.baseRevision).toBeNull();
  });
});
