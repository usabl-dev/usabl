/**
 * A receipt is re-checkable proof that this tree, this policy, and this runner
 * produced `verified`. `verdict` is the literal `'verified'` (a type, not a decision).
 * Only `run()` calls this, and only after the gate returned verified.
 *
 * Four bindings: sourceTree (current Git working tree), policyHash (guarded-path
 * blobs at HEAD), runnerVersion, and scannerVersions (axe-core, Playwright, Chromium).
 * Lists are sorted so the same inputs hash the same way.
 */
import type { Deps, Receipt, UsablConfig } from "../contracts/index.js";
import { sortBy } from "../primitives/sortKey.js";
import { canonicalHash } from "../primitives/canonical.js";
import { buildGuardedSet, expandGuardedSet } from "../trust/guard.js";

export interface ReceiptArgs {
  surfaces: string[];
  checked: string[];
  notCovered: string[];
  findingsSummary: Receipt["findingsSummary"];
  activeWaivers: number;
  baseRevision?: string | null;
}

/**
 * Mint and verify share this one hash function so receipt trust has one fingerprint.
 * Two algorithms would let verify drift into a friendlier hash and still claim valid.
 *
 * We hash HEAD blob shas from lsTree, not working-tree bytes, so receipts bind committed
 * policy state instead of a dirty copy that can change between runs.
 */
export async function computePolicyHash(
  deps: Deps,
  guardedPaths: string[],
): Promise<string> {
  const blobs = await deps.git.lsTree("HEAD", guardedPaths);
  const pairs = sortBy(Object.entries(blobs), ([path]) => path);
  return canonicalHash(pairs);
}

export async function mintReceipt(
  deps: Deps,
  config: UsablConfig,
  args: ReceiptArgs,
): Promise<Receipt> {
  // Mint uses the same expanded guarded input as verify so an engine-minted receipt
  // can re-verify without relying on caller-side pre-expansion conventions.
  const expandedGuardedPaths = await expandGuardedSet(
    deps,
    buildGuardedSet(config),
  );
  const [sourceTree, policy] = await Promise.all([
    deps.git.writeTree(),
    computePolicyHash(deps, expandedGuardedPaths),
  ]);
  return {
    schemaVersion: 1,
    sourceTree,
    baseRevision: args.baseRevision ?? null,
    policyHash: policy,
    runnerVersion: deps.runnerVersion,
    scannerVersions: deps.scannerVersions,
    surfaces: sortBy([...args.surfaces], (s) => s),
    coverage: {
      checked: sortBy([...args.checked], (s) => s),
      notCovered: sortBy([...args.notCovered], (s) => s),
    },
    verdict: "verified",
    findingsSummary: args.findingsSummary,
    activeWaivers: args.activeWaivers,
    mintedAt: deps.clock(),
  };
}

export interface ReceiptVerification {
  valid: boolean;
  failedFields: string[];
}

/**
 * Verification expands guarded directories before hashing so newly added policy files
 * also move the receipt fingerprint. Without expansion, self-edits under a guarded
 * directory could re-verify against an incomplete path list.
 */
export async function verifyReceipt(
  deps: Deps,
  config: UsablConfig,
  receipt: Receipt,
  currentSourceTree: string,
): Promise<ReceiptVerification> {
  const failedFields: string[] = [];
  const expandedGuardedPaths = await expandGuardedSet(
    deps,
    buildGuardedSet(config),
  );
  const policyHash = await computePolicyHash(deps, expandedGuardedPaths);

  if (receipt.sourceTree !== currentSourceTree) {
    failedFields.push("sourceTree");
  }
  if (receipt.policyHash !== policyHash) {
    failedFields.push("policyHash");
  }
  if (receipt.runnerVersion !== deps.runnerVersion) {
    failedFields.push("runnerVersion");
  }
  // scannerVersions is what actually decides the verdict (axe-core et al.). It is minted
  // into the receipt, so verify must compare it too; a swapped scanner is a different engine.
  const mintedScanners = receipt.scannerVersions;
  const currentScanners = deps.scannerVersions;
  if (
    mintedScanners.axeCore !== currentScanners.axeCore ||
    mintedScanners.playwright !== currentScanners.playwright ||
    mintedScanners.chromium !== currentScanners.chromium
  ) {
    failedFields.push("scannerVersions");
  }

  return {
    valid: failedFields.length === 0,
    failedFields,
  };
}
