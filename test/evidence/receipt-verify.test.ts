import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { computePolicyHash, mintReceipt, verifyReceipt } from '../../src/evidence/receipt.js';
import { buildGuardedSet, expandGuardedSet } from '../../src/trust/guard.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'src/gate'],
};

const mintArgs = {
  surfaces: ['cli'],
  checked: ['clusters'],
  notCovered: [],
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
};

const guardFiles = {
  'usabl.config.json': '{"guardedPaths":["src/gate"]}',
  'src/gate/index.ts': 'safe',
};

const guardBlobs = {
  'usabl.config.json': 'blob-config-a',
  'src/gate/index.ts': 'blob-gate-a',
};

describe('verifyReceipt', () => {
  it('re-verifies a receipt minted from the expanded guarded set', async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });

    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
    const receipt = await mintReceipt(deps, { ...config, guardedPaths: expanded }, mintArgs);

    expect(receipt.policyHash).toBe(await computePolicyHash(deps, expanded));
    await expect(verifyReceipt(deps, config, receipt, 'tree-a')).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
  });

  it('re-verifies a receipt minted from raw guarded config', async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });

    const receipt = await mintReceipt(deps, config, mintArgs);
    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));

    expect(receipt.policyHash).toBe(await computePolicyHash(deps, expanded));
    await expect(verifyReceipt(deps, config, receipt, 'tree-a')).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
  });

  it('fails only sourceTree when current source tree differs', async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });

    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
    const receipt = await mintReceipt(deps, { ...config, guardedPaths: expanded }, mintArgs);

    await expect(verifyReceipt(deps, config, receipt, 'tree-b')).resolves.toEqual({
      valid: false,
      failedFields: ['sourceTree'],
    });
  });

  it('fails policyHash when guarded blobs change at HEAD', async () => {
    const mintDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });
    const verifyDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: { ...guardBlobs, 'src/gate/index.ts': 'blob-gate-b' },
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });

    const expanded = await expandGuardedSet(mintDeps, buildGuardedSet(config));
    const receipt = await mintReceipt(mintDeps, { ...config, guardedPaths: expanded }, mintArgs);

    await expect(verifyReceipt(verifyDeps, config, receipt, 'tree-a')).resolves.toEqual({
      valid: false,
      failedFields: ['policyHash'],
    });
  });

  it('fails runnerVersion when engine version differs', async () => {
    const mintDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.1.0',
    });
    const verifyDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: 'tree-a',
      runnerVersion: '0.2.0',
    });

    const expanded = await expandGuardedSet(mintDeps, buildGuardedSet(config));
    const receipt = await mintReceipt(mintDeps, { ...config, guardedPaths: expanded }, mintArgs);

    await expect(verifyReceipt(verifyDeps, config, receipt, 'tree-a')).resolves.toEqual({
      valid: false,
      failedFields: ['runnerVersion'],
    });
  });
});
