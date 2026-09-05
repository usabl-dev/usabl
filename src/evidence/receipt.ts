/**
 * A receipt is re-checkable proof that this tree, this policy, and this runner
 * produced `verified`. `verdict` is the literal `'verified'` (a type, not a decision).
 * Only `run()` calls this, and only after the gate returned verified.
 *
 * Four bindings: sourceTree (current Git working tree), policyHash (guarded-path
 * blobs at HEAD), runnerVersion, and scannerVersions (axe-core, Playwright, Chromium).
 * Lists are sorted so the same inputs hash the same way.
 */
import type { Deps, Receipt, ScreenScan, UsablConfig } from "../contracts/index.js";
import { sortBy } from "../primitives/sortKey.js";
import { canonicalHash } from "../primitives/canonical.js";
import { buildGuardedSet, expandGuardedSet } from "../trust/guard.js";

export interface ReceiptArgs {
  surfaces: string[];
  checked: string[];
  notCovered: string[];
  applicability: Receipt["applicability"];
  findingsSummary: Receipt["findingsSummary"];
  activeWaivers: number;
  baseRevision?: string | null;
}

/**
 * Summarize, per scanned screen, how many rules examined at least one element (applied) versus
 * how many matched nothing (abstained). This is the receipt's record of what was actually
 * checked, not only what was found. It is informational: the receipt records it, verifyReceipt
 * never compares it, and it never gates. A screen with no applicability data (an unseen screen,
 * stripped upstream) is omitted rather than recorded as 0/0 noise. Sorted by screenId so the
 * same inputs produce the same receipt bytes.
 */
export function summarizeApplicability(
  screens: readonly ScreenScan[],
): Receipt["applicability"] {
  // Count unique rules, not observations. A screen scanned more than once, or a rule observed
  // more than once on a screen (a duplicate-render case), is still one logical rule and counts
  // once. Deduplicate to one record per (screenId, layer, rule) first, so a repeated scan cannot
  // turn "1 applied" into "2 applied". A rule is applied if any observation examined an element
  // (outcome other than inapplicable), and abstained only if every observation matched nothing,
  // so a rule seen once as passed and once as inapplicable is one applied rule, never both.
  const appliedByRule = new Map<string, boolean>();
  const screenOfRule = new Map<string, string>();
  for (const screen of screens) {
    for (const entry of screen.applicability) {
      const key = JSON.stringify([screen.screenId, entry.layer, entry.rule]);
      const appliedNow = entry.outcome !== "inapplicable";
      appliedByRule.set(key, (appliedByRule.get(key) ?? false) || appliedNow);
      screenOfRule.set(key, screen.screenId);
    }
  }
  const byScreen = new Map<string, { applied: number; abstained: number }>();
  for (const [key, applied] of appliedByRule) {
    const screenId = screenOfRule.get(key) ?? "";
    const counts = byScreen.get(screenId) ?? { applied: 0, abstained: 0 };
    if (applied) {
      counts.applied += 1;
    } else {
      counts.abstained += 1;
    }
    byScreen.set(screenId, counts);
  }
  return sortBy(
    [...byScreen.entries()].map(([screenId, counts]) => ({ screenId, ...counts })),
    (summary) => summary.screenId,
  );
}

/**
 * Normalize a per-screen applicability list to one row per screenId, then sort. summarizeApplicability
 * already produces this shape, so for the engine's own call this only sorts. It exists so a caller
 * that builds ReceiptArgs directly, and might pass duplicate or unordered screen rows, still yields
 * byte-stable receipt bytes: duplicate screen rows are summed into one, and the result is ordered.
 */
function normalizeReceiptApplicability(
  rows: Receipt["applicability"],
): Receipt["applicability"] {
  const byScreen = new Map<string, { applied: number; abstained: number }>();
  for (const row of rows) {
    const counts = byScreen.get(row.screenId) ?? { applied: 0, abstained: 0 };
    counts.applied += row.applied;
    counts.abstained += row.abstained;
    byScreen.set(row.screenId, counts);
  }
  return sortBy(
    [...byScreen.entries()].map(([screenId, counts]) => ({ screenId, ...counts })),
    (row) => row.screenId,
  );
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
    // Normalize here too, the way surfaces and coverage are sorted, so the receipt is byte-stable
    // for the same run no matter what order or duplicates a caller supplied. summarizeApplicability
    // already returns one sorted row per screen, so this only sorts for the engine's own call; it
    // protects any other caller that builds ReceiptArgs directly.
    applicability: normalizeReceiptApplicability(args.applicability),
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
