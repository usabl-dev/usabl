import { describe, expect, it } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { verifyReceipt } from '../../src/evidence/receipt.js';
import { run } from '../../src/run.js';

const baseConfig: UsablConfig = {
  appBaseUrl: 'http://localhost:3000',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://localhost:3000/clusters', files: ['src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json', 'src/gate'],
};

const baseFloor: EvidenceFloor = { version: 1, entries: [] };
const configBytes = JSON.stringify(baseConfig);
const emptyWaivers = JSON.stringify({ version: 1, waivers: [] });
const stableGateBytes = 'export const gateAnchor = "stable";';

const unnamedButtonDraft: Draft = {
  rule: 'button-name',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: null,
  role: 'button',
  whatUserExperiences: 'Screen reader announces button without a name',
  why: 'Button has no accessible name',
  fix: 'Add an accessible name',
  evidence: {},
  confidence: 'fail',
};

function withPolicyFiles(
  files: Record<string, string>,
  headContents: Record<string, string>,
): { files: Record<string, string>; headContents: Record<string, string> } {
  return {
    files: {
      'usabl.config.json': configBytes,
      '.usabl-evidence.json': JSON.stringify(baseFloor),
      '.usabl-waivers.json': emptyWaivers,
      'src/gate/index.ts': stableGateBytes,
      ...files,
    },
    headContents: {
      'usabl.config.json': configBytes,
      '.usabl-evidence.json': JSON.stringify(baseFloor),
      '.usabl-waivers.json': emptyWaivers,
      'src/gate/index.ts': stableGateBytes,
      ...headContents,
    },
  };
}

function screenWith(drafts: Draft[]): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://localhost:3000/clusters',
    stops: [],
    drafts,
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
  };
}

describe('phase3 exit criterion integration', () => {
  it('blocks with approval_required when waiver ledger is edited in working tree', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          '.usabl-waivers.json': JSON.stringify({
            version: 1,
            waivers: [
              {
                rule: 'button-name',
                surface: 'clusters',
                scope: '*',
                reason: 'temporary',
                owner: 'owner',
                approvedBy: 'approver',
                created: '2026-01-01T00:00:00.000Z',
                expires: '2027-01-01T00:00:00.000Z',
              },
            ],
          }),
        },
        {},
      ),
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('approval_required');
    expect(result.receipt).toBeNull();
  });

  it('blocks config self-drop even when caller passes guardedPaths as empty', async () => {
    const configSelfDrop: UsablConfig = { ...baseConfig, guardedPaths: [] };
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"v":2,"guardedPaths":[]}',
        '.usabl-evidence.json': JSON.stringify(baseFloor),
        '.usabl-waivers.json': emptyWaivers,
        'src/gate/index.ts': stableGateBytes,
      },
      headContents: {
        'usabl.config.json': configBytes,
        '.usabl-evidence.json': JSON.stringify(baseFloor),
        '.usabl-waivers.json': emptyWaivers,
        'src/gate/index.ts': stableGateBytes,
      },
    });

    const result = await run(deps, configSelfDrop, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['usabl.config.json']);
    expect(result.receipt).toBeNull();
  });

  it('blocks guarded engine edits when src/gate/index.ts diverges from HEAD', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          'src/gate/index.ts': 'export const gateAnchor = "changed";',
        },
        {},
      ),
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toContain('src/gate/index.ts');
    expect(result.receipt).toBeNull();
  });

  it('converges to verified and receipt re-verifies on accepted count-based floor', async () => {
    const acceptedFloor: EvidenceFloor = {
      version: 1,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'button-name',
          elementKey: null,
          identityBasis: 'count',
          count: 1,
        },
      ],
    };
    const acceptedFloorJson = JSON.stringify(acceptedFloor);
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          '.usabl-evidence.json': acceptedFloorJson,
        },
        {
          '.usabl-evidence.json': acceptedFloorJson,
        },
      ),
      headBlobs: {
        'usabl.config.json': 'blob-config',
        '.usabl-evidence.json': 'blob-evidence',
        '.usabl-waivers.json': 'blob-waivers',
        'src/gate/index.ts': 'blob-gate',
      },
      writeTree: 'tree-accepted',
      scans: { clusters: screenWith([unnamedButtonDraft]) },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('verified');
    expect(result.receipt).not.toBeNull();

    if (result.receipt === null) {
      throw new Error('expected receipt for verified result');
    }
    await expect(verifyReceipt(deps, baseConfig, result.receipt, 'tree-accepted')).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
  });
});
