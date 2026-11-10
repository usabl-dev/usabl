/**
 * A receipt is re-checkable proof that this tree, this policy, and this runner
 * produced `verified`. `verdict` is the literal `'verified'` (a type, not a decision).
 * Only `run()` calls this inside usabl, and only after the gate returned verified. It is also
 * exported, so it checks the ids it is handed (see checkReceiptInput).
 *
 * Five bindings: sourceTree (current Git working tree), policyHash (guarded-path
 * blobs at HEAD), runnerVersion, scannerVersions (axe-core, Playwright, Chromium, and the
 * version of each optional commercial engine the config turned on), and
 * historyHead (the debt history commit, which can lower the debt a run accepts).
 * Lists are sorted so the same inputs hash the same way.
 */
import type {
  CoverageGap,
  Deps,
  Finding,
  Receipt,
  ScannerVersions,
  ScreenScan,
  UsablConfig,
  Waiver,
} from "../contracts/index.js";
import { sortBy } from "../primitives/sortKey.js";
import { canonicalHash } from "../primitives/canonical.js";
import { assertIso8601Utc } from "../primitives/iso8601.js";
import { buildGuardedSet, expandGuardedSet } from "../trust/guard.js";
import { assertIdField, InputRefusedError } from "../intake/input-refusal.js";

/**
 * The receipt schema version mint writes and verify accepts. Raise it only when a receipt minted
 * under the old version could verify wrongly under the new rules. A new binding whose absent
 * value can be read safely (see waiverExpiresAt) does not need a raise.
 */
export const RECEIPT_SCHEMA_VERSION = 2 as const;

export interface ReceiptArgs {
  surfaces: string[];
  checked: string[];
  notCovered: string[];
  applicability: Receipt["applicability"];
  findingsSummary: Receipt["findingsSummary"];
  activeWaivers: number;
  // The earliest expiry among the waivers the run applied, or null when it applied none. See
  // earliestAppliedWaiverExpiry. Required whenever activeWaivers is above 0.
  waiverExpiresAt?: string | null;
  // The tree identity the run read before it planned, and read again unchanged after it scanned.
  // run() always passes it, so the receipt binds the tree the scan saw. When absent, mint reads the
  // tree itself, which is right only for a caller that knows nothing changed since its check.
  sourceTree?: string;
  baseRevision?: string | null;
  // The debt history commit the run read, or null when it read none. See currentHistoryHead.
  historyHead?: string | null;
}

/** The value a scanner version reader returns when it cannot read the version. */
export const UNREADABLE_SCANNER_VERSION = "unknown";

const SCANNER_NAMES = [
  ["axeCore", "axe-core"],
  ["playwright", "Playwright"],
  ["chromium", "Chromium"],
] as const;

/**
 * The names of the core scanners whose version could not be read, in a fixed order. A receipt
 * binds these versions so a changed scanner cannot reuse an old result. A version that reads as
 * "unknown", or as nothing, would match itself after the scanner changed, so it binds nothing.
 */
export function unreadableScanners(versions: ScannerVersions): string[] {
  return SCANNER_NAMES.filter(([key]) => {
    const value: unknown = versions[key];
    return typeof value !== "string" || value.trim().length === 0 || value.trim() === UNREADABLE_SCANNER_VERSION;
  }).map(([, name]) => name);
}

/** Scanner names as one phrase: "Chromium", "axe-core and Playwright", "a, b and c". */
export function scannerNamesText(names: readonly string[]): string {
  return joinNames(names);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What to do about scanner versions usabl could not read. The run's gap and doctor both use it, so
 * the two always name the same fix.
 */
export function scannerVersionFix(names: readonly string[]): string {
  const packages = names.filter((name) => name !== "Chromium");
  const steps: string[] = [];
  if (packages.length > 0) {
    steps.push(
      `For ${joinNames(packages)}, reinstall your dependencies (for example "npm ci") so each package has a ` +
        "package.json with a version.",
    );
  }
  if (names.includes("Chromium")) {
    steps.push(
      'For Chromium, run "npx playwright install chromium" from your app root. If PLAYWRIGHT_BROWSERS_PATH ' +
        "points Playwright at a browser you placed there yourself, such as a system Chromium, make sure that " +
        "browser prints its version when run with --version, or keep the folder name Playwright gives it, " +
        "such as chromium-1234.",
    );
  }
  return steps.join(" ");
}

/**
 * The gap owed when a scanner version cannot be read, or none. A receipt without a real version
 * could verify after that scanner changed, so such a run mints no receipt. The gate ranks the gap
 * as not_covered, so the run never reads as verified.
 */
export function scannerVersionGaps(versions: ScannerVersions): CoverageGap[] {
  const names = unreadableScanners(versions);
  if (names.length === 0) return [];
  return [
    {
      ref: "scanner versions",
      state: "not-covered",
      reason:
        `usabl could not read the version of ${joinNames(names)}. A receipt records every scanner version so ` +
        "that a changed scanner cannot reuse an old result, and a version usabl cannot read could change " +
        `without anyone seeing it. So this run cannot verify accessibility and mints no receipt. ${scannerVersionFix(names)} ` +
        'Then run "usabl doctor" to confirm the version reads, and run usabl again.',
    },
  ];
}

function isIso8601Utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertIso8601Utc(value, "time");
    return true;
  } catch {
    return false;
  }
}

// The waiver match rule the gate applies (src/gate, applyWaivers): same rule, same screen, and a
// scope of '*' or the finding's element key.
function waiverMatches(waiver: Waiver, finding: Finding): boolean {
  return (
    waiver.rule === finding.rule &&
    waiver.surface === finding.screenId &&
    (waiver.scope === "*" || waiver.scope === finding.elementKey)
  );
}

/**
 * The earliest expiry among the waivers this run applied, or null when no finding was waived.
 *
 * A waiver applied when it was live at `now` (its expiry is later, as the gate compares them) and
 * it matches a finding the gate marked waived. A live waiver that matched nothing changes nothing
 * when it ends, so it is not bound, and the fast path is not cut short by it.
 *
 * This repeats the gate's match rule, because the gate does not say which waiver it used. If the
 * two ever differ, some waived finding is matched by no waiver here. Then the earliest expiry of
 * every live waiver is bound instead. If no waiver was live at all, `now` is bound, so the receipt
 * never verifies. Either way a drift can only bind an earlier time, never a later one.
 *
 * Expiries are ISO-8601 UTC text, checked by the waiver parser, so text order is time order.
 */
export function earliestAppliedWaiverExpiry(
  findings: readonly Finding[],
  waivers: readonly Waiver[],
  now: string,
): string | null {
  const waived = findings.filter((finding) => finding.status === "waived");
  if (waived.length === 0) return null;
  const live = waivers.filter((waiver) => waiver.expires > now);
  const applied = live.filter((waiver) => waived.some((finding) => waiverMatches(waiver, finding)));
  const explained = waived.every((finding) => applied.some((waiver) => waiverMatches(waiver, finding)));
  const bound = explained ? applied : live;
  if (bound.length === 0) return now;
  return sortBy(bound.map((waiver) => waiver.expires), (expires) => expires)[0]!;
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

const MINT_SOURCE = "mintReceipt() input";

function assertList(field: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new InputRefusedError(field, `${MINT_SOURCE} ${field} must be an array.`);
  }
}

/**
 * mintReceipt() is exported, so a library caller can hand it a config that never went through
 * the config parser and receipt arguments that never came from the gate. Every screen and surface
 * id it is handed is checked against the shared id grammar here, so the receipt never records an
 * id the rest of usabl would refuse. A refusal names the field and its position and never repeats
 * the id. On the command path these ids already passed the parser, so this refuses nothing there.
 *
 * The grammar governs screen and surface ids only. Receipt `surfaces` are output channels such as
 * "cli" and `notCovered` holds file paths, so neither is checked here.
 */
function checkReceiptInput(deps: Deps, config: UsablConfig, args: ReceiptArgs): void {
  const checked: unknown = args.checked;
  assertList("args.checked", checked);
  checked.forEach((id, index) => assertIdField(MINT_SOURCE, `args.checked[${index}]`, id));

  const applicability: unknown = args.applicability;
  assertList("args.applicability", applicability);
  applicability.forEach((row, index) => {
    const field = `args.applicability[${index}]`;
    if (typeof row !== "object" || row === null) {
      throw new InputRefusedError(field, `${MINT_SOURCE} ${field} must be an object.`);
    }
    assertIdField(MINT_SOURCE, `${field}.screenId`, (row as Record<string, unknown>)["screenId"]);
  });

  const surfaces: unknown = config.surfaces;
  assertList("config.surfaces", surfaces);
  surfaces.forEach((surface, index) => {
    const field = `config.surfaces[${index}]`;
    if (typeof surface !== "object" || surface === null) {
      throw new InputRefusedError(field, `${MINT_SOURCE} ${field} must be an object.`);
    }
    assertIdField(MINT_SOURCE, `${field}.id`, (surface as Record<string, unknown>)["id"]);
  });

  // Keys are named by position, counted from one in the order Object.keys returns them, as the
  // config parser names them. A key is never printed, for the same reason an id is not.
  const perSurface = config.noiseBudget?.perSurface;
  if (perSurface !== undefined) {
    Object.keys(perSurface).forEach((key, index) =>
      assertIdField(MINT_SOURCE, `config.noiseBudget.perSurface key ${index + 1}`, key),
    );
  }

  // A receipt that counts a waiver must say when the first of them ends, or it would verify after
  // the waiver is gone. A value that is not a time could never be compared with the clock.
  const expiry: unknown = args.waiverExpiresAt ?? null;
  if (expiry !== null && !isIso8601Utc(expiry)) {
    throw new InputRefusedError(
      "args.waiverExpiresAt",
      `${MINT_SOURCE} args.waiverExpiresAt must be null or an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).`,
    );
  }
  const unreadable = unreadableScanners(deps.scannerVersions);
  if (unreadable.length > 0) {
    throw new InputRefusedError(
      "deps.scannerVersions",
      `${MINT_SOURCE} cannot bind the version of ${joinNames(unreadable)}, because it could not be read.`,
    );
  }
  if (args.activeWaivers !== 0 && expiry === null) {
    throw new InputRefusedError(
      "args.waiverExpiresAt",
      `${MINT_SOURCE} args.waiverExpiresAt must name when the first applied waiver ends, because activeWaivers is not 0.`,
    );
  }
}

export async function mintReceipt(
  deps: Deps,
  config: UsablConfig,
  args: ReceiptArgs,
): Promise<Receipt> {
  checkReceiptInput(deps, config, args);
  // Mint uses the same expanded guarded input as verify so an engine-minted receipt
  // can re-verify without relying on caller-side pre-expansion conventions.
  const expandedGuardedPaths = await expandGuardedSet(
    deps,
    buildGuardedSet(config),
  );
  const [sourceTree, policy] = await Promise.all([
    args.sourceTree ?? deps.git.writeTree(),
    computePolicyHash(deps, expandedGuardedPaths),
  ]);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    sourceTree,
    baseRevision: args.baseRevision ?? null,
    historyHead: args.historyHead ?? null,
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
    waiverExpiresAt: args.waiverExpiresAt ?? null,
    mintedAt: deps.clock(),
  };
}

/**
 * The gap owed when the tree identity read before planning differs from the one read after the
 * scan. The scan then saw files that may not be the files the run planned from or the files there
 * now, so nothing it measured can be bound to one tree. The gate ranks this gap as not_covered,
 * and a run that is not verified mints no receipt.
 */
export function treeChangedDuringCheckGap(): CoverageGap {
  return {
    ref: "working tree",
    state: "not-covered",
    reason:
      "The files in this repository changed while usabl was checking them, so the screens it scanned " +
      "may not show the code as it is now. This run cannot verify accessibility and mints no receipt. " +
      "Wait until no editor, build, or agent is writing files, then run usabl again.",
  };
}

/**
 * The debt history commit as it is now, for comparing with a receipt. Null when the caller passed
 * no history reader or there is no history branch. A read that fails is a value no receipt holds,
 * so the receipt does not verify and the Stop hook runs a full check, which is the safe side.
 */
export async function currentHistoryHead(deps: Deps): Promise<string | null> {
  if (deps.history === undefined) return null;
  try {
    return await deps.history.resolveCommit(deps.history.ref);
  } catch {
    return "unreadable";
  }
}

/**
 * Whether two runs used the same commercial engines at the same versions. Absent and empty both
 * mean no engine was on, so a receipt minted before engines existed still matches a run that turns
 * none on. A receipt and a run that differ in which engines are on, or in any engine's version,
 * used different scanners.
 */
function sameEngines(minted: ScannerVersions["engines"], current: ScannerVersions["engines"]): boolean {
  const a = minted ?? {};
  const b = current ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

export interface ReceiptVerification {
  valid: boolean;
  failedFields: string[];
}

/**
 * Whether the waivers a receipt relied on are all still live, and if not, why. Null when they are.
 *
 * A receipt with a bound expiry stands until the clock reaches it, the moment the gate stops
 * applying that waiver. A receipt minted before the binding existed has no field. It is read as
 * "no waiver applied" only when it counted no waived finding, which is the same fact. A receipt that
 * counted one and binds no time, or binds something that is not a time, does not verify. The clock
 * is the injected one, so the answer depends on nothing else.
 */
function waiverExpiryProblem(receipt: Receipt, now: string): string | null {
  const expiry: unknown = (receipt as { waiverExpiresAt?: unknown }).waiverExpiresAt;
  const counted = receipt.activeWaivers !== 0;
  if (expiry === undefined || expiry === null) {
    return counted
      ? "the receipt counts a waived accessibility barrier but does not record when that waiver ends, so it cannot show the waiver is still live"
      : null;
  }
  if (!isIso8601Utc(expiry)) {
    return "the receipt's waiver end is not an ISO-8601 UTC time, so it cannot be compared with the clock";
  }
  if (!isIso8601Utc(now)) {
    return "the clock did not give an ISO-8601 UTC time, so usabl cannot tell whether the waiver the receipt used is still live";
  }
  if (now >= expiry) {
    return `a waiver this receipt relied on ended at ${expiry}, so the accessibility barrier it waived counts again`;
  }
  return null;
}

const FIELD_REASONS: Record<string, string> = {
  schemaVersion: "the receipt was written in a format this usabl does not verify",
  sourceTree: "the files changed since the receipt was minted",
  policyHash: "the committed policy changed since the receipt was minted",
  runnerVersion: "a different usabl engine minted the receipt",
  historyHead: "the debt history moved since the receipt was minted",
  scannerVersions: "the scanners differ from the ones that minted the receipt, or a version could not be read",
};

/**
 * One plain sentence per failed field of a verification, in the same order, for a person reading
 * why a stored receipt did not stand. `now` is the same injected clock value verify compared.
 */
export function receiptFailureReasons(receipt: Receipt, failedFields: readonly string[], now: string): string[] {
  return failedFields.map((field) =>
    field === "waiverExpiresAt"
      ? (waiverExpiryProblem(receipt, now) ?? "the waiver end the receipt records does not stand")
      : (FIELD_REASONS[field] ?? `the receipt field ${field} does not match`),
  );
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

  // The store reads only this version too. Checking here as well keeps a library caller that
  // hands in any other shape from verifying under rules written for this one.
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    failedFields.push("schemaVersion");
  }
  if (receipt.sourceTree !== currentSourceTree) {
    failedFields.push("sourceTree");
  }
  if (receipt.policyHash !== policyHash) {
    failedFields.push("policyHash");
  }
  if (receipt.runnerVersion !== deps.runnerVersion) {
    failedFields.push("runnerVersion");
  }
  // The history lowers what a run accepts. A receipt minted before it moved was judged against
  // more accepted debt than a run now would be, so it no longer stands for this tree.
  if (receipt.historyHead !== (await currentHistoryHead(deps))) {
    failedFields.push("historyHead");
  }
  // scannerVersions is what actually decides the verdict (axe-core et al.). It is minted
  // into the receipt, so verify must compare it too; a swapped scanner is a different engine.
  const mintedScanners = receipt.scannerVersions;
  const currentScanners = deps.scannerVersions;
  if (
    mintedScanners.axeCore !== currentScanners.axeCore ||
    mintedScanners.playwright !== currentScanners.playwright ||
    mintedScanners.chromium !== currentScanners.chromium ||
    !sameEngines(mintedScanners.engines, currentScanners.engines) ||
    // A version that could not be read matches itself after the scanner changed, so it never
    // counts as a match, on either side.
    unreadableScanners(mintedScanners).length > 0 ||
    unreadableScanners(currentScanners).length > 0
  ) {
    failedFields.push("scannerVersions");
  }
  // Verification never reads the wall clock directly. deps.clock is the injected clock.
  if (waiverExpiryProblem(receipt, deps.clock()) !== null) {
    failedFields.push("waiverExpiresAt");
  }

  return {
    valid: failedFields.length === 0,
    failedFields,
  };
}
