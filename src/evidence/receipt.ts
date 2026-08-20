import type { Deps, Receipt, UsablConfig } from '../contracts/index.js';
import { sortBy } from '../primitives/sortKey.js';
import { canonicalHash } from '../primitives/canonical.js';

export interface ReceiptArgs {
  surfaces: string[];
  checked: string[];
  notCovered: string[];
  findingsSummary: Receipt['findingsSummary'];
  activeWaivers: number;
  baseRevision?: string | null;
}

/** policyHash: sha256 over sorted [path, blobSha] pairs of guarded paths at HEAD. */
async function policyHash(deps: Deps, guardedPaths: string[]): Promise<string> {
  const blobs = await deps.git.lsTree('HEAD', guardedPaths);
  const pairs = sortBy(Object.entries(blobs), ([path]) => path);
  return canonicalHash(pairs);
}

export async function mintReceipt(deps: Deps, config: UsablConfig, args: ReceiptArgs): Promise<Receipt> {
  const [sourceTree, policy] = await Promise.all([deps.git.writeTree(), policyHash(deps, config.guardedPaths)]);
  return {
    schemaVersion: 1,
    sourceTree,
    baseRevision: args.baseRevision ?? null,
    policyHash: policy,
    runnerVersion: deps.runnerVersion,
    scannerVersions: deps.scannerVersions,
    surfaces: sortBy([...args.surfaces], (s) => s),
    coverage: { checked: sortBy([...args.checked], (s) => s), notCovered: sortBy([...args.notCovered], (s) => s) },
    verdict: 'verified',
    findingsSummary: args.findingsSummary,
    activeWaivers: args.activeWaivers,
    mintedAt: deps.clock(),
  };
}
