/**
 * usabl kernel vocabulary for verdicts, evidence, coverage, and injected seams.
 * This unit defines shared shapes only.
 * It must never mint a verdict, infer a pass, or hide not-covered work.
 * Layers project a Result, but the gate remains the only verdict authority.
 */

// ---- verdict + evidence vocabulary ----
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
// Evidence class is provenance, not authority. Deterministic can gate today (or later by promotion).
// Preview and model-judgment stay visible for operator context and never mint a gate verdict.
export type EvidenceClass =
  | 'deterministic'
  | 'preview'
  | 'model-judgment'
  | 'human-confirmed';
// Verdict is the gate output when gating ran. `verdict: null` is intentional disclosure for idle
// or fail-open runs, not a fifth verdict and not a synonym for not_covered.
export type Verdict =
  | 'verified'
  | 'regression'
  | 'not_covered'
  | 'approval_required';
// Accessibility fields never carry approval_required. That verdict is policy, not a scan outcome.
export type AccessibilityVerdict = Exclude<Verdict, 'approval_required'>;
// AccessibilityExitCode never includes 2. Crash is 4.
export type AccessibilityExitCode = 0 | 1 | 3 | 4;
export type FactSource = 'ax-tree' | 'attribute';
// 'row' keys a control inside a keyed table row by the row and the control's place in it, so the
// same control in two rows never shares an identity. Only a version 3 floor holds row entries.
export type IdentityBasis = 'name' | 'structural' | 'count' | 'row';

// ---- evidence + findings ----
export interface Fact<T = string | null> {
  value: T;
  source: FactSource;
  fromTree: boolean;
}
export interface EvidenceFacts {
  name?: Fact;
  role?: Fact;
  state?: Record<string, Fact<unknown>>;
  extra?: Record<string, unknown>;
}
// Providers emit Draft only. They report observations and confidence, but never set status or verdict.
export interface Draft {
  rule: string;
  layer: string; // built-in ids: 'axe' | 'pf' | 'walk'; stays open
  severity: Severity;
  evidenceClass: EvidenceClass; // only 'deterministic' (or later promoted) mints the gate verdict; preview and model-judgment surface, they never gate
  screenId: string;
  elementPath: string;
  elementName: string | null;
  role: string | null;
  whatUserExperiences: string;
  why: string;
  fix: string;
  evidence: EvidenceFacts;
  confidence: 'fail' | 'unverified';
}
// ---- docs source mapping (presentation-only enrichment for docs findings) ----
// Which tier resolved a docs finding to its AsciiDoc source. renderer = exact file+line from a
// cooperating sourcemap pass; content = file+construct matched in the include closure; fallback =
// the page's assembly file with the whole closure disclosed. See src/docs/source-map.ts.
export type SourceMapTier = 'renderer' | 'content' | 'fallback';
// How a docs finding maps back to the markup its author edits. run() attaches this after the gate,
// so it never influences identity, the floor, or the verdict; it only makes a finding speak source.
export interface DocsSourceMapping {
  tier: SourceMapTier;
  file: string | null; // primary attributed source file; null only when a fallback has no assembly
  candidates: string[]; // every source that could own the construct; the whole closure on fallback
  construct: string | null; // the author's markup (image::x, link:..., '=== Title'); null on fallback
  line: number | null; // exact source line, from the renderer tier only
  fix: string; // the fix phrased in the format's own syntax where a construct is known
}

// Finding is gate-owned enrichment. The gate adds identity and lifecycle status to each Draft.
export interface Finding extends Draft {
  elementKey: string | null; // null when identityBasis is 'count'
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
  // Docs findings only: source mapping run() attaches after the gate. Absent on app findings and on
  // docs findings whose page closure could not be resolved. Presentation only, never gates.
  docsSource?: DocsSourceMapping;
  // App findings only: source mapping run() attaches after the gate. Uses renderer attrs on the
  // DOM when present, otherwise the route import chain or coverage hints. Presentation only.
  appSource?: AppSourceMapping;
}

// ---- app source mapping ----
// renderer = data-source-file/line from the cooperating Vite dev transform or DOM attrs;
// import-chain = the changed UI file on the route graph path to this screen;
// coverage = changed UI files disclosed as candidates when ownership is ambiguous.
export type AppSourceTier = 'renderer' | 'import-chain' | 'coverage';
export interface AppSourceMapping {
  tier: AppSourceTier;
  file: string | null;
  line: number | null;
  candidates: string[];
}

// ---- announcement / transcript (keyboard walk transcript and the voicing lane) ----
export interface AnnouncementToken {
  kind: 'name' | 'role' | 'state' | 'live';
  text: string | null;
  fromTree: boolean;
  source: FactSource;
}
export interface TranscriptStop {
  index: number;
  elementPath: string;
  announcement: AnnouncementToken[];
  // Set only when the element that has focus at this stop cannot be read. The path is then the
  // host or the frame, and the announcement holds no name, role, or state of the control, so a
  // check must not read their absence as a barrier.
  focusUnreadable?: FocusUnreadable;
  // Set only when the document body had focus at this stop, as read from the page. The path cannot
  // say so: a body with an id has that id as its path. The blank-page detector reads this field.
  onBody?: true;
  // Set only by a runner that waits for the page to settle after each step, when the page was still
  // changing at the end of that wait. Focus and announcements were then read on a page that had not
  // finished reacting, so a check must not decide anything from this stop. waitedMs is for people
  // reading a transcript; no draft carries it, because it is wall-clock time.
  unsettled?: { waitedMs: number };
  // Set only by that runner, when its drain cannot say which announcements a screen reader heard.
  // See AnnouncementUndecidable.
  drainUndecidable?: AnnouncementUndecidable;
}
// ---- applicability (what a rule did on a screen, recorded and never judged) ----
// Silence from a check has two meanings that look identical in a findings list: the rule ran
// against matching elements and found nothing wrong, or the rule matched nothing at all and
// never had an opinion. Recording the outcome per rule per screen keeps those apart.
// Nothing here classifies an outcome as expected or suspicious, and nothing here gates.
export type RuleOutcome = 'failed' | 'incomplete' | 'passed' | 'inapplicable';
export interface RuleApplicability {
  screenId: string;
  layer: string;
  rule: string;
  outcome: RuleOutcome;
  // Elements the rule matched on this screen. axe reports zero for an inapplicable rule, and the
  // count is read from what the run returned rather than assumed from the outcome. A design-system
  // pack that does not apply reports 0 for each rule because none of its rules ran.
  elementCount: number;
}

// A provider's disclosure about a screen: something it did not read there, said so a reader knows,
// with no claim about the screen. Disclosure only. It is never a verdict input and never a coverage
// gap, and the gate never reads it, so it cannot block a screen or mark one checked. The ref names
// the provider and the subject, for example provider:rhds-rulepack/out-of-document. The reason is
// engine words and counts, never page text.
export interface ProviderNote {
  ref: string;
  reason: string;
}

export interface ScreenScan {
  screenId: string;
  url: string;
  stops: TranscriptStop[];
  drafts: Draft[];
  gaps: CoverageGap[];
  // Required, never optional. An absent field would read as "nothing applied here", which is the
  // confusion this record exists to remove. Empty means nothing was reported, which is honest for
  // a scan that failed or for providers that say nothing about applicability.
  applicability: RuleApplicability[];
  // What the providers disclosed about this screen that is neither a finding nor a gap. Every scan
  // the engine builds sets it, empty when there is nothing to disclose. It is optional only so the
  // many hand-built scans in older tests and a Result written by an older engine keep their shape;
  // absent reads as no notes. Disclosure only: nothing that decides a verdict reads it.
  notes?: ProviderNote[];
  // Positive reachability evidence, measured during the scan while the live DOM was available.
  // The tri-state is deliberate:
  //   null  = the surface declared no reachedWhen selector, so we make no claim either way.
  //   true  = a reachedWhen selector was declared and at least one element matched it both when
  //           the keyboard walk began and after the checks, so the screen provably rendered before
  //           usabl touched it.
  //   false = a reachedWhen selector was declared and nothing matched it at one of those moments,
  //           so the walk or the checks ran on a page without what the operator said proves it
  //           loaded.
  // Only false triggers an unseen gap in markUnseenScreens. The value is a plain presence test,
  // never a count or a DOM walk, so a verdict that leans on it cannot depend on iteration order.
  reachedSelectorPresent: boolean | null;
  // Set only when the screen ended before the walk because its declared selector did not hold
  // within the signal wait: the signalTimeoutMs cap that ran out, carried so the gap can name it.
  // Such a scan has no stops, drafts, or applicability, because nothing was walked or checked.
  signalWaitMs?: number;
  // The reachedWhen selector the surface declared, carried so a coverage gap can name it in plain
  // English. Optional and only meaningful when reachedSelectorPresent is false. Absent or null when
  // the surface declared no selector.
  reachedWhenSelector?: string | null;
  // The response half of the readiness signal, measured at the same moments as the selector. The
  // same tri-state: absent or null when the surface declared no response, true when a fetch or XHR
  // request to the declared path on the application's own host had answered with a 2xx status
  // before the keyboard walk began, false when no such answer was seen by then. Only false
  // triggers an unseen gap in markUnseenScreens.
  reachedResponseSeen?: boolean | null;
  // The response path the surface declared, carried so a coverage gap can name it. Absent or null
  // when the surface declared no response.
  reachedWhenResponse?: string | null;
  // 'off' when the page was scanned in a browser that usabl started without Chromium's sandbox,
  // because the system could not provide one. Absent means usabl did not report it off: the
  // browser ran with its sandbox, or the page came from a caller's own browser. Disclosure only:
  // the gate never reads it and it never changes a verdict.
  browserSandbox?: 'off';
  // The images the screen showed, read only when the docs generator asks for them. Page text,
  // so untrusted. Nothing in the gate reads it. Absent means the images were not read, which is
  // not the same as a screen with no images (an empty list).
  images?: PageImage[];
  // How many more images the screen showed beyond the ones listed. Absent when none were left out.
  imagesNotListed?: number;
}
// One image as the accessibility tree reported it. The name and role are page-derived.
export interface PageImage {
  elementPath: string;
  name: string | null;
  role: string | null;
  // The page marks the image as decorative: an empty alt attribute, or role none or presentation.
  // Chromium leaves such an image out of the accessibility tree, so the tree alone cannot say it.
  decorative: boolean;
}

// ---- coverage ----
export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual' | 'docs-manifest';
  importChain?: string[];
  // Why a wide-blast screen is checked, naming the changed file, when a dependency change of the
  // app queued it: a change to the app's dependencies or to a lockfile. Absent otherwise.
  reason?: string;
  profile?: ProfileName;
}
/**
 * One floored identity where the evidence floor records more barriers than the run observed.
 *
 * Disclosure, never a verdict input. The recorded count is a high-water mark that only
 * `usabl floor prune` lowers, so the difference is room a new barrier can take at a collapsed
 * identity while the tally stays at or under what was accepted. That hole is open until the floor
 * is re-armed, and usabl says so on every run rather than blocking: on a real brownfield floor
 * these counts track how many rows a live table renders, so a blocking rule would fail unchanged
 * code whenever a list came back shorter.
 *
 * Screen id and rule only. An element key carries a neutralized accessible name or element path,
 * both page-derived, and this travels into a pull request comment and into what a model reads.
 */
export interface FloorHeadroom {
  screenId: string;
  rule: string;
  recorded: number; // barriers the floor accepted at this identity
  observed: number; // deterministic barriers this run actually saw there
}
/**
 * Floored barriers on one screen that this run did not see and cannot call fixed.
 *
 * The screen was scanned cleanly, but nothing shows the part of the page that held them rendered:
 * the screen declares no reachedWhen signal that held, and the walk and the checks met none of
 * their elements. A fixed barrier and content that never mounted look the same from here, so these
 * stay on the floor as debt and every surface says so. Disclosure only: this never moves the
 * verdict.
 *
 * Screen id, rule names and a count. Never an element key, because a key carries page text.
 */
/**
 * Why automatic debt tracking was off on a run. A code, not a sentence, so a surface writes its own
 * words and the only text a Result carries here is `detail`, which a surface prints as a value.
 *
 * - `no-reader`: the caller passed no history reader (a library call).
 * - `no-history`: there is no history branch to read.
 * - `unreadable`: the history branch exists and could not be read. `detail` says where and why.
 * - `old-floor`: the evidence floor predates row keys, so history records cannot be matched to it.
 * - `no-base`: the base commit could not be resolved, so usabl cannot tell which records apply.
 */
export type DebtTrackingOff = 'no-reader' | 'no-history' | 'unreadable' | 'old-floor' | 'no-base';

/**
 * The accessibility debt a run worked against, for the pull request comment and `usabl debt`.
 *
 * Barrier counts, never element keys. `floorBarriers` is what the committed floor accepts.
 * `acceptedBarriers` is what this run accepted after the fixes main confirmed, so it is never above
 * `floorBarriers`. `fixedThisRun` is what this run did not see of the accepted debt, which counts
 * as fixed in this change until main confirms it. `remaining` is accepted minus fixed this run.
 */
export interface DebtStatus {
  tracking: 'on' | 'off';
  off: { cause: DebtTrackingOff; detail: string | null } | null;
  historyHead: string | null;
  floorBarriers: number;
  acceptedBarriers: number;
  confirmedFixed: number;
  fixedThisRun: number;
  remaining: number;
  // Whole days since the oldest remaining barrier was first seen on main, or null when unknown.
  oldestOpenDays: number | null;
  // Barriers whose fix came back on an unchanged tree. They keep their slot and are not released.
  intermittent: number;
}

export interface FloorUnconfirmed {
  screenId: string;
  rules: string[]; // sorted, each rule once
  barriers: number; // the sum of the recorded counts of the entries on this screen
}
export interface CoverageGap {
  ref: string; // surface id, url, or file path this gap concerns
  state: 'unresolved' | 'not-covered' | 'skipped' | 'capability-denied';
  reason: string; // why it was not exercised; never empty because unresolved is evidence, not idle
}
export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[]; // in-scope surfaces or checks that could not be exercised, each with a reason
  nothingToCheck: boolean; // no UI-touching files; not a verdict
  // Changed files that match uiFileGlobs but that the planner left out on purpose, each with why.
  // Today these are files under a test folder that no screen imports. Disclosure only: an excluded
  // file is not a gap, the gate never reads this list, and it never moves a verdict. Optional so a
  // Result written before it existed still reads; absent and empty both mean nothing was excluded.
  excludedFiles?: ExcludedFile[];
}
export interface ExcludedFile {
  ref: string; // the repository path of the changed file
  reason: string; // why the planner did not count it as a UI file, and what would make it count
}
// The gate treats unresolved files and coverage gaps as not-covered evidence.

// ---- receipt (re-checkable proof of a verified run) ----
// Receipts exist only for verified deterministic outcomes. Preview and model-judgment never mint one.
// The scanner stack a run used. A receipt binds it, so a swapped scanner fails re-verification.
// `engines` names each optional commercial engine the config turned on, by engine id, with the
// installed package version. Absent when no engine is on, so receipts minted before engines existed
// keep the same shape and still verify.
export interface ScannerVersions {
  axeCore: string;
  playwright: string;
  chromium: string;
  engines?: Record<string, string>;
}
export interface Receipt {
  // Version 2 added historyHead. A version 1 receipt is not read, so it triggers one full run.
  schemaVersion: 2;
  sourceTree: string;
  baseRevision: string | null;
  // The commit of the debt history branch when this receipt was minted, or null when there was
  // none. The history lowers the debt a run accepts, so a receipt minted before the history moved
  // must not stand for a run after it. See src/history/.
  historyHead: string | null;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: ScannerVersions;
  surfaces: string[];
  coverage: { checked: string[]; notCovered: string[] };
  // What the run actually examined, per scanned screen: rules that examined at least one element
  // (applied) versus rules that matched nothing (abstained). This exists so a verified receipt
  // states what was checked, not only what was found. It is recorded, never re-verified:
  // verifyReceipt does not compare it, because applicability legitimately varies with app state
  // (a dialog present one run, absent the next), and it never gates. Screens with no applicability
  // data (unseen screens, stripped upstream) are omitted.
  applicability: { screenId: string; applied: number; abstained: number }[];
  verdict: 'verified';
  findingsSummary: { new: number; carried: number; fixed: number; unverified: number };
  activeWaivers: number;
  signature?: string; // reserved for later signed attestation; unused today
  mintedAt: string;
}

// ---- the whole serializable output ----
export interface Result {
  schemaVersion: 'usabl.result.v1'; // versioned contract; every projection echoes it
  verdict: Verdict | null; // null when idle or fail-open disclosure; never a hidden extra verdict
  summary: string;
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  // Accessibility outcome with policy divergence ignored. The gate mints this so CI
  // can split enforcement without GitHub or the workflow inventing a verdict.
  // Never approval_required and never exit 2. Crash runs use exitCode 4 and leave these as null / 4.
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  // Count of floor entries whose barrier this run did not observe on a cleanly scanned screen.
  // Not a count of fixes: absence is what a paid-down barrier looks like and equally what a table
  // rendering no rows looks like, and nothing here can tell the two apart. These are the entries a
  // floor prune would remove. run() does not modify the floor; pruning does. This is projection
  // only; the gate never consumes it and it never influences a verdict.
  paidDownCount: number;
  // Floored identities where the floor records more barriers than this run observed, so the floor
  // is ahead of the application. Why is not knowable from here: barriers may have been fixed, or
  // the page may render fewer rows today. Surfaces report the two counts and leave the cause to
  // the operator. Required, never optional: an absent field would read as "no headroom", and a
  // disclosure that can go missing is not a disclosure.
  // Projection only. The gate never consumes it and it never influences a verdict.
  floorHeadroom: FloorHeadroom[];
  // Floored barriers on cleanly scanned screens that this run did not see and has no evidence
  // were rendered, so they are not claimed fixed. Required for the same reason as floorHeadroom.
  // Projection only. The gate never consumes it and it never influences a verdict.
  floorUnconfirmed: FloorUnconfirmed[];
  // What the debt history did on this run: whether automatic tracking was on, and the counts the
  // pull request comment reports. Projection only. The gate never reads it. Optional because a
  // Result from an older engine, or one a library caller composed, has none, and a surface then
  // says nothing about tracking.
  debt?: DebtStatus;
  // Present only when the CI judge produced this Result with --isolated-browser. Disclosure only:
  // the gate never reads it. A blocked request is already a coverage gap on its screen.
  judge?: JudgeDisclosure;
}

export interface JudgeDisclosure {
  isolatedBrowser: true;
  // Requests the isolated browser aborted because their origin was not allowed, over the run.
  blockedRequests: number;
  // sha256 of the build archive the judge scanned, or null when no digest was supplied.
  buildDigest: string | null;
}
// exitCode: 0 verified or nothing-to-check; 1 regression; 2 approval_required;
// 3 not_covered; 4 unhandled error (fail open with disclosure);
// 5 reserved for an opt-in judgment soft-gate (off by default). The default install never emits 5,
// and the Result reader (src/intake/result-document.ts) refuses a document that carries 5 until
// that gate exists.

// ---- conformance summary: a NON-GATING projection of Result, never a single score ----
// Always shows every bucket side by side; never hides the not-evaluated denominator. The gate
// verdict stays the authority; this is a read-only view for CI comments and the ACCESSIBILITY.md row.
export interface ConformanceSummary {
  verdict: Verdict | null; // echoes Result.verdict (the gate is the authority)
  // Whether this run stops the work, read from the exit code the gate wrote. Not recomputed from
  // the findings: while it was, a run held at not_covered by a new unconfirmed finding reported
  // "blocked: no" directly under a NOT COVERED heading.
  blocked: boolean;
  deterministic: {
    // Every new deterministic finding, which is what the gate counts and what the surfaces list.
    // The failing and unconfirmed split is reported beside it, never instead of it: while `new`
    // held failures only, the pull request comment printed "new 1" above a list of three.
    new: number;
    newFailing: number;
    newUnconfirmed: number;
    carried: number;
    waived: number;
    fixed: number;
  };
  judged: { modelJudgment: number; preview: number }; // advisory provenance; never gates
  notEvaluated: { unresolvedFiles: number; gaps: number };
}

// ---- evidence floor + waivers ----
export interface FloorEntry {
  screenId: string;
  layer: string; // built-in: 'axe' | 'pf' | 'walk'
  rule: string;
  elementKey: string | null;
  identityBasis: IdentityBasis;
  count: number; // observed barriers at this identity; version 1 floors only recorded it for count basis
}
export interface EvidenceFloor {
  // Version 1 recorded a literal 1 for name and structural entries, so those counts prove nothing.
  // Version 2 records the observed count for every basis, so the gate can compare all of them.
  // Version 3 also keys a control inside a keyed table row per row (identity basis 'row'). Version 1
  // and 2 floors recorded those controls collapsed across rows, so the gate compares them with the
  // keys they were written with and discloses a gap until `usabl baseline` rewrites the floor.
  version: 1 | 2 | 3;
  // Present and 'partial' only when `usabl baseline --partial` wrote a floor from a subset of the
  // application, the screens that were cleanly scanned. A complete whole-application floor omits
  // this field entirely, so its bytes stay identical to floors written before this field existed.
  // No consumer changes behavior on scope. It is a label a reader can see in the committed file.
  scope?: 'partial';
  entries: FloorEntry[];
}
export interface Waiver {
  rule: string;
  surface: string; // matches Finding.screenId
  scope: string; // matches Finding.elementKey, or '*' for the whole rule on the surface
  reason: string;
  owner: string;
  approvedBy: string;
  created: string; // ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ)
  expires: string; // ISO-8601 UTC; ignored once past
}
export interface WaiverLedger {
  version: 1;
  waivers: Waiver[];
}

// ---- interaction contracts (frozen shapes; voice requirements become these) ----
export interface Step {
  do: string;
  [key: string]: unknown;
}
export interface StepRunner {
  run(page: Page, steps: Step[]): Promise<TranscriptStop[]>;
}
export interface SpeechObligation {
  class: string; // promotion keys on this
  afterStep: number; // index into steps; checked only in that step's window
  requiredTokens: string[]; // semantic name/role/state/consequence tokens
  focusedRole?: string;
  mustAnnounce: boolean; // true = consequence must reach a live region (structural gate)
}
export interface InteractionContract {
  contractId: string;
  surfaceId: string;
  task: string;
  steps: Step[];
  obligations: SpeechObligation[];
  maxTabPath?: number;
}

// ---- design intake + docs output (producers wired; reachable via `usabl docs` and the usabl/docs export) ----
export type RequirementKind =
  | 'content'
  | 'flow'
  | 'doc'
  | 'voice'
  | 'name'
  | 'heading'
  | 'landmark'
  | 'focus-order'
  | 'target-size';
export interface ContentAssertion {
  type: 'content';
  selector: string;
  expectedText?: string;
  mustNotBe?: 'decorative' | 'empty';
}
export interface FlowAssertion {
  type: 'flow';
  steps: Array<{ do: string; [key: string]: unknown }>;
  expectedAnnouncement?: string;
}
export interface DocAssertion {
  type: 'doc';
  artifact: 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths';
}
// An interaction contract written in the requirements folder. The requirement id becomes the
// contract id, its surface the contract surface, and its description the contract task.
export interface VoiceAssertion {
  type: 'voice';
  steps: Step[];
  obligations: SpeechObligation[];
  maxTabPath?: number;
}
// The roles a design requirement can name, the roles designers annotate. A requirement finds its
// element by role and accessible name, the way a designer names it, and the browser accessibility
// tree decides the role, so a div with role="button" is a button.
export type TargetRole =
  | 'button'
  | 'link'
  | 'heading'
  | 'img'
  | 'textbox'
  | 'checkbox'
  | 'menuitem'
  | 'tab'
  | 'main'
  | 'navigation'
  | 'banner'
  | 'contentinfo'
  | 'complementary'
  | 'region'
  | 'search'
  | 'form';
export type LandmarkRole = Extract<
  TargetRole,
  'main' | 'navigation' | 'banner' | 'contentinfo' | 'complementary' | 'region' | 'search' | 'form'
>;
// One element as a designer names it: what it is and what it is called. The name is compared with
// the accessible name exactly, after trimming both.
export interface RoleTarget {
  role: TargetRole;
  name: string;
}
// The element with this role and name exists on the screen.
export interface NameAssertion {
  type: 'name';
  target: RoleTarget;
}
// The heading with this name is at this level.
export interface HeadingAssertion {
  type: 'heading';
  name: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}
// The screen has a landmark with this role, and this name when one is given.
export interface LandmarkAssertion {
  type: 'landmark';
  role: LandmarkRole;
  name?: string;
}
// Tab from the start of the screen reaches these names in this order. Other stops may come
// between them. Each name is listed once.
export interface FocusOrderAssertion {
  type: 'focus-order';
  sequence: string[];
}
// The element is at least this many CSS pixels wide and high.
export interface TargetSizeAssertion {
  type: 'target-size';
  target: RoleTarget;
  minCssPx: number;
}
// Where a requirement drafted from a design came from, so a design change after approval can be
// flagged. Every field is read from the design tool, checked by the loader, and treated as data.
export interface RequirementSource {
  tool: 'figma';
  file: string; // the file key
  node: string; // the id of the design node the requirement was drafted from
  version: string; // the file version the requirement was drafted from
}
export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion:
    | ContentAssertion
    | FlowAssertion
    | DocAssertion
    | VoiceAssertion
    | NameAssertion
    | HeadingAssertion
    | LandmarkAssertion
    | FocusOrderAssertion
    | TargetSizeAssertion;
  owner?: string;
  approved: boolean;
  source?: RequirementSource;
}
export interface RequirementBundle {
  version: 1;
  requirements: Requirement[];
}
export interface DocArtifact {
  kind: 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths';
  surface: string;
  entries: Array<{
    element: string;
    content: string;
    status: 'draft' | 'approved';
    evidenceRef?: string;
    // 'page' means usabl drafted this entry from the page's own text because no content
    // requirement covered the surface. Such an entry is always a draft, never carries evidence,
    // and needs a person to review it. Absent means the entry came from a content requirement.
    origin?: 'page';
  }>;
  generatedAt: string;
  boundToReceipt?: string;
  // The git tree the report was made from: the receipt's tree when the run minted one, otherwise
  // the tree read when the docs run started. Absent when usabl could not read a tree.
  sourceTree?: string;
  // The tree read when the docs run started, recorded only when it differs from the receipt's
  // tree in sourceTree. Then a file changed while the run scanned, the scan saw no one whole tree,
  // and the report is stale against every tree.
  startTree?: string;
  // Set when the report is listed or read against a tree other than sourceTree, it records no
  // tree, or a file changed while it was made. The report needs to be made again, and nothing in
  // it is proof for the code as it is now. staleReason says which trees differ and what to run.
  stale?: true;
  staleReason?: string;
}

// ---- injected dependencies (all I/O enters here; run() has none of its own) ----
// Why the element that has focus cannot be read. Its path and accessibility node would then be the
// host or the frame that holds it, the same for every control inside, so a walk could read the second
// control as a return to the first.
// 'closed-shadow-root': focus is inside a closed shadow root.
// 'frame-unreadable': focus is inside a frame usabl cannot look inside, such as one from another origin,
// or the frame of an object, embed, or fencedframe element, which the read does not enter.
// 'focus-too-deep': focus sits under more shadow roots and frames than the read follows.
export type FocusUnreadable = 'closed-shadow-root' | 'frame-unreadable' | 'focus-too-deep';

// Why a drain cannot say which announcements a screen reader heard.
// 'closed-shadow-modal': a modal dialog is open inside a closed shadow root. The capture cannot see
// it, so it cannot tell which regions it leaves out of the accessibility tree.
// 'changed-element-removed': a modal dialog is open now, and a change was recorded on an element
// that is no longer in the document, so whether the modal hid it cannot be read.
export type AnnouncementUndecidable = 'closed-shadow-modal' | 'changed-element-removed';

// How a wait for the page to react to one action ended, and how long it waited.
export interface ActionSettle {
  settled: boolean;
  waitedMs: number;
}

export interface AnnouncementDrain {
  texts: string[];
  undecidable: AnnouncementUndecidable | null;
}

// Where one drained text came from. region names the live region that wrote it, the same number
// for the same region on every drain of one document. removalOnly is true when the change was only
// a removal inside the region, which is how a toast that dismisses itself shows up: the record
// then holds the text the region has left, which no one announced.
export interface AnnouncementSource {
  region: number;
  removalOnly: boolean;
}

// A drain with the source of each text, in the same order as texts. sources is null when the page
// cannot say, so a check that needs the sources reads that as unknown, never as heard.
export interface AnnouncementSourcesDrain extends AnnouncementDrain {
  sources: AnnouncementSource[] | null;
}

export interface AxNode {
  name: string | null;
  role: string | null;
  states: Record<string, unknown>;
}
// One node of the whole accessibility tree, as Page.fullAxTree reads it. The browser computes the
// tree, so no page script world takes part. Values are never read: a field's value, and the text
// inside an editable field, are left out, so they cannot reach evidence.
export interface AxTreeNode {
  // The DOM backend node id, which names the same node across two reads of one document.
  nodeId: number;
  // The nearest ancestor that has a DOM node, or null at the top.
  parentId: number | null;
  role: string | null;
  // Null for an ignored node, which assistive technology does not perceive.
  name: string | null;
  // Ignored nodes are kept so the parent chain stays whole. Comparisons skip them.
  ignored: boolean;
  // Only the states a change is judged on: checked, expanded, pressed, selected, invalid, and sort,
  // each as text. A state the node does not have is absent.
  states: Record<string, string>;
  // aria-busy is true on this node.
  busy: boolean;
  // The nodes its aria-controls names that the browser exposes, by backend node id.
  controls: number[];
}
// What one read of the whole accessibility tree returned. A read that needs more than the budget
// in time or in nodes is not a tree: a check that compares trees cannot use it, and says so.
export type AxTreeRead =
  | { kind: 'tree'; documentNodeId: number | null; nodes: AxTreeNode[] }
  | { kind: 'over-budget'; limit: 'time' | 'nodes' };
export interface ElementRef {
  selector: string;
}
// Why the box Page.boundingBox read may not be the area a pointer can hit. Each one is read on the
// element and on every element above it in the flat tree.
// 'rotated-or-skewed': a transform, or the rotate property, turns or slants the element, so the
// axis-aligned box around it is larger than the element. A translate or a scale alone does not.
// 'clip-path': a clip-path, or the older clip property, cuts the element's shape.
// 'mask': a mask image hides part of the element.
// 'overflow-clipped': an element above it has overflow other than visible on an axis (hidden,
// clip, auto, scroll, or overlay), or paint containment, and the element reaches past that
// element's padding box on that axis, so only part of it can be on screen at once. On the root and
// the body, only hidden and clip count, because their scrolling is the viewport's.
// 'outside-viewport': the element, or an element above it, is fixed or sticky, and the element
// reaches past the viewport, where scrolling cannot bring it into view.
export type BoxLimit = 'rotated-or-skewed' | 'clip-path' | 'mask' | 'overflow-clipped' | 'outside-viewport';
// What Page.boundingBox read about one element. `width` and `height` are the CSS pixel size of its
// border box as the browser lays it out, transforms included. `fragments` is how many boxes the
// element is laid out in: an inline element that wraps onto two lines has two, and its size is the
// box around both. `unmeasurable` lists each BoxLimit that holds, in the order of that type, and is
// empty only when the box is the area a pointer can hit, as far as usabl reads it.
export interface ElementBox {
  width: number;
  height: number;
  fragments: number;
  unmeasurable: BoxLimit[];
}
// Why a row an element sits in could not be told apart from other rows. See RowContextRead.
export type RowAmbiguity =
  // The table keys its rows, and this row has no key of the kind the table uses.
  | 'row-key-missing'
  // Another row of the same table has exactly the same key.
  | 'row-key-duplicate'
  // The key, or the table's identity, is longer than usabl reads.
  | 'row-key-too-long'
  // Another table on the screen has the same identity, so the two cannot be told apart.
  | 'table-ambiguous'
  // The table sits in a row of another table that keys none of its rows, so the row it sits in has
  // no identity, and neither does anything under it.
  | 'enclosing-row-unkeyed';

// Why usabl could not find the one element a selector names. See RowContextRead.
export type RowUnreadable =
  // The page could not parse the selector.
  | 'selector-invalid'
  // The selector matched no element: the element went away after the scanner saw it.
  | 'element-missing'
  // The selector matched more than one element, so which one the scanner meant is unknown.
  | 'element-multiple'
  // The element sits in a frame usabl could not look inside: one from another origin, or a part of
  // the target that names something that is not a frame.
  | 'frame-unreadable';

// Where the one element a row read is about sits. A string is one selector in the top document. A
// list has one entry per document, outermost first, the way axe-core names an element in a frame.
// Each entry is the selectors from that document down through each open shadow root: the first
// matches in the document, and each one after it matches in the shadow root of the element the one
// before it matched. The last element an entry names is the frame the next entry looks inside.
export type ElementTarget = string | readonly (readonly string[])[];

// What Page.rowContext read about the table row an element sits in.
//
// 'none': the element is not in a body row of a table whose rows carry keys. It keys the way it did
// before row keys existed, and nothing was lost.
// 'keyed': the element is in a row usabl can tell apart from every other row on the screen.
// `table` and `key` are page text, exact and in full, and must never be stored: the caller hashes
// them at once. `table` names the table without using its position: its own key attribute, its
// accessible name, or its caption, after the identity of the row it is nested in, if any.
// 'ambiguous': the element is in a row of a keyed table, but the row cannot be told apart. So is an
// element under such a row, or under a table that cannot be told apart. The caller must not key it
// by row, and must disclose that it could not.
// 'unreadable': the target did not name exactly one element, or named one inside a frame usabl
// could not look inside, so whether that element sits in a keyed row is unknown. The caller must
// disclose it, exactly as for 'ambiguous'. Only an element that was found and seen outside every
// body row of a keyed table is 'none'.
//
// The row is read on the tree the element is drawn in: up through a shadow root to its host, and
// up out of a same-origin frame to the frame element, so a control in a web component or a frame
// that sits in a keyed row belongs to that row. A table whose role is presentation or none is a
// layout table and is not a table here, unless its own rows carry keys.
export type RowContextRead =
  | { kind: 'none' }
  | {
      kind: 'keyed';
      table: string;
      // Where the key came from: 'attr:<name>' for a key attribute on the row, 'header' for a row header.
      source: string;
      key: string;
      // The element's role attribute, or a role implied by its tag, or its tag name.
      role: string;
      // Tag and child position from the row down to the element, for example
      // 'td:nth-child(4) > button:nth-child(1)'. Empty when the element is the row itself.
      path: string;
      // The keys of the table's other body rows, from the same source, and the identities of every
      // other table on the screen. Page text like `key` and `table`, so the caller only hashes them.
      // They let the caller check that no two rows of the table, and no two tables, share a hash.
      otherKeys: string[];
      otherTables: string[];
    }
  | { kind: 'ambiguous'; reason: RowAmbiguity }
  | { kind: 'unreadable'; reason: RowUnreadable };
// What Page.ancestorAttributes read. 'chain' is the element and every element above it, nearest
// first. 'not-found' means no connected element matched, for example a toast that closed between
// two reads. 'too-deep' means the walk reached `limit` elements and had more to go, so the chain is
// incomplete. A caller must not read either of those two as an element with no live ancestors.
export type AncestorAttributesRead =
  | { kind: 'chain'; chain: Array<Record<string, string | null>> }
  | { kind: 'not-found' }
  | { kind: 'too-deep'; limit: number };

// One answer to a fetch or XHR request the page made, as the network tracker recorded it.
export interface ApiResponse {
  url: string;
  status: number;
  // The Content-Type header the answer carried, as sent, or null when it carried none. An HTML
  // answer is a page, such as a sign-in page or a history fallback, not the data that was asked for.
  contentType: string | null;
  // Whether the request was sent before Page.markWalkStart, so before usabl pressed a key or ran a
  // check. Its answer can arrive later. True for every request until the mark is set. A request the
  // tracker never saw sent reads as false once the mark is set, because nothing dates it.
  sentBeforeWalk: boolean;
}
// What readiness waits for beyond a settled page. holds is asked only at a moment when the DOM is
// stable and the network is quiet. timeoutMs caps the wait, counted from the first such moment.
export interface ReadinessProbe {
  holds(): Promise<boolean>;
  timeoutMs: number;
}
// How the readiness wait ended. not-declared: no probe was given and the page settled. held: the
// probe answered true at a settled moment. timed-out: a probe was given and never held before its
// cap or the readiness budget ran out, settled or not. A caller must act on timed-out as it is:
// reading the signal again afterwards can find an element that appeared on a page still changing.
export interface ReadinessOutcome {
  signal: 'held' | 'timed-out' | 'not-declared';
}
export interface Page {
  // 'off' when the browser this page runs in started without Chromium's sandbox, because the
  // system could not provide one. Absent on a page from a sandboxed browser and on a caller's own
  // page, which usabl did not launch.
  browserSandbox?: 'off';
  // Waits until the page stopped changing and the network went quiet. With readyWhen, it also
  // waits until readyWhen.holds answers true at a moment when both of those hold, for at most
  // readyWhen.timeoutMs after the first such moment and always inside the readiness budget. A page
  // can settle on a small shell, pause with nothing in flight, and only then fetch and mount its
  // real content, and only a positive signal tells that pause from a finished page. The cap is
  // counted from the first settled moment and checked on every pass, so a page that keeps changing
  // after it cannot stretch it. When the cap runs out, or the budget runs out on a settled page,
  // before the probe held, it returns timed-out rather than throwing, and the caller treats the
  // screen as a gap.
  gotoReady(readyWhen?: ReadinessProbe): Promise<ReadinessOutcome>;
  // Where the browser actually is now, which is not always where it was sent. An application can
  // answer a request for a screen with a redirect, and a scan that never asks has no way to know
  // it measured a different page. Read it after the screen has loaded and before anything on the
  // page is exercised, because providers click and press keys and a click can navigate.
  currentUrl(): Promise<string>;
  // Every response to the page's own data requests (fetch and XHR) since navigation, in arrival
  // order, with its status. This is what lets a refused request be read against what came after
  // it, and what a declared readiness response is looked up in. Documents and assets are left
  // out, because an authentication wall answers 200 to those too. Empty means no data response was
  // seen, which is not proof that none was sent: one still in flight at the read is not here.
  apiResponses(): Promise<ApiResponse[]>;
  // Marks the moment before the keyboard walk begins. A data request sent after it was caused by
  // usabl or arrived during the checks, so it never counts toward the screen's readiness response.
  // A request sent before it counts whenever its answer arrives. Only the first call sets the mark.
  markWalkStart(): Promise<void>;
  // URLs of the page's own data requests (fetch and XHR) that came back 401 between navigation and
  // the moment this is read. A single page application that stays at the requested address and
  // swaps in a login form leaves no trace in the URL and may not have rendered the form yet, so
  // this is the one signal that does not depend on the address or the DOM. It is NOT free of a
  // timing race: an application slower than the readiness settle has sent nothing when a first
  // read happens, which is why the check runner reads it again at the end of the scan. A 401 that
  // arrives after that last read is never seen. 401 only: 403 means authenticated and not
  // permitted. Empty means no refused request was seen, which is not proof the session worked.
  unauthorizedApiRequests(): Promise<string[]>;
  // How many elements match a selector anywhere in the page: every frame, and inside open shadow
  // roots. document.querySelectorAll sees neither, so a login form in an iframe or a web component
  // is invisible to queryAll. This makes no claim about where the matches are, only how many.
  countEverywhere(selector: string): Promise<number>;
  focusBody(): Promise<void>;
  tab(): Promise<void>;
  press(key: string): Promise<void>;
  click(selector: string): Promise<void>;
  activeElementIs(selector: string): Promise<boolean>;
  activeElementWithin(selector: string): Promise<boolean>;
  armAnnouncementCapture(): Promise<void>;
  // Waits for the page to react to one action: the element count holds and the network is quiet,
  // by the same signals gotoReady reads, under a cap of its own that is far shorter than the
  // page-load budget. It never throws for a page that keeps changing; it returns settled false.
  settleAfterAction(): Promise<ActionSettle>;
  drainAnnouncements(): Promise<string[]>;
  // The same drain, with the reason the texts cannot be trusted to be what a screen reader heard,
  // or null when they can. See AnnouncementDrain.
  drainAnnouncementRecord(): Promise<AnnouncementDrain>;
  // The same drain, with where each text came from. See AnnouncementSourcesDrain.
  drainAnnouncementSources(): Promise<AnnouncementSourcesDrain>;
  // The accessibility node of the element that has focus, followed into open shadow roots and
  // same-origin frames. Null when the node is missing or ignored, and null when activeFocusUnreadable
  // reports a reason, because the node read then would be the host or the frame, not the control.
  activeNode(): Promise<AxNode | null>;
  // The path of the element that has focus, followed into open shadow roots and same-origin frames.
  // An element outside every shadow root and frame keeps the path a selector read gives it. Past a
  // boundary, the path of each tree is joined by ' >> ' for a shadow root and by
  // ' >> internal:control=enter-frame >> ' for a frame, so each control has its own path.
  activePath(): Promise<string>;
  // A key for the element that has focus. It stays the same while that element stays in the
  // document, even when elements around it are added or removed and its path changes. Null when no
  // element has focus or it cannot be read. The key holds no page text and means something only on
  // this page while it is open, so nothing stores it or compares it across pages or runs.
  activeElementKey(): Promise<string | null>;
  // Why the element that has focus cannot be read, or null when it can. See FocusUnreadable.
  activeFocusUnreadable(): Promise<FocusUnreadable | null>;
  // The paths of the open modal dialogs that hold the element that has focus, nearest first, in the
  // form activePath gives. A dialog element opened with showModal() is one. So is an element whose
  // first recognized role is dialog or alertdialog with aria-modal true, while it is shown and not
  // hidden from assistive technology. The read climbs the flat tree, so a dialog in a shadow root
  // holds the content slotted into it, and it climbs out of same-origin frames. Empty when no such
  // dialog holds focus, and when nothing has focus.
  activeModalDialogs(): Promise<string[]>;
  // The DOM backend node id of the element that has focus, followed into open shadow roots and
  // same-origin frames. Null when nothing has focus, and null when activeFocusUnreadable reports a
  // reason, because the element read then would be the host or the frame, not the control.
  focusedNodeId(): Promise<number | null>;
  // The DOM backend node id of the element a click step's CSS selector names, read in an isolated
  // world, so page script cannot answer for it. The query looks in the document and in every open
  // shadow root, as the click does. Null when nothing matches, when the selector is not CSS the
  // browser parses, and when matches sit both in the document and in a shadow root, because the
  // click's own order across those cannot be read. Null too when the selector holds a combinator
  // and the page has any open shadow root, because the click can match a combinator across a
  // shadow boundary and the browser's own query cannot. Several matches in the document alone
  // resolve to the first, which is the one the click takes.
  controlNodeId(selector: string): Promise<number | null>;
  // The whole accessibility tree of the main frame, read from the browser over
  // Accessibility.getFullAXTree. It covers open shadow roots, because the browser builds the tree
  // from the flat tree, and it does not cover child frames. See AxTreeRead for the budget.
  fullAxTree(): Promise<AxTreeRead>;
  axAt(selector: string): Promise<AxNode | null>;
  // The accessibility node of the first element innerSelector matches inside the open shadow root
  // of the first element hostSelector matches in the document. A web component's inner control,
  // such as the native button inside rh-button, is reachable only this way, because axAt reads the
  // document and stops at the host. Null when the host is missing, has no open shadow root, nothing
  // inside it matches, or the node is missing or ignored. Read in an isolated world, so page script
  // cannot point the read at another element.
  axInShadowRoot(hostSelector: string, innerSelector: string): Promise<AxNode | null>;
  // What the first element a selector matches in the document holds in its own markup. Markup
  // facts only, used by component rules to tell whether a name source exists. A name itself always
  // comes from the accessibility tree. Null when nothing matches. See HostMarkup.
  hostMarkup(selector: string): Promise<HostMarkup | null>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  // The named attributes of the element a selector matches and of each element above it, nearest
  // first: the element itself, then its parent, up to the root. The walk follows the flat tree that
  // the accessibility tree is built from, so a slotted element climbs through its slot, in an open
  // or a closed shadow root, and a shadow root climbs to its host. A missing attribute reads as
  // null. See AncestorAttributesRead for the two results that carry no chain.
  ancestorAttributes(selector: string, names: readonly string[]): Promise<AncestorAttributesRead>;
  queryAll(selector: string): Promise<ElementRef[]>;
  // The table row the one element a target names sits in. See RowContextRead and ElementTarget. A
  // selector the page cannot parse, or one that matches no element or more than one, is
  // 'unreadable', never 'none'. It throws when the page cannot be read.
  rowContext(target: ElementTarget): Promise<RowContextRead>;
  // The table row the element that has focus sits in, read through open shadow roots and
  // same-origin frames to the element itself. Read at the moment of the call, so a provider that
  // finds a barrier at a focus stop reads the row of the element it saw, not one a selector names
  // later.
  focusedRowContext(): Promise<RowContextRead>;
  close(): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  setZoom(percent: number): Promise<void>;
  setReducedMotion(enabled: boolean): Promise<void>;
  getComputedStyle(selector: string, property: string): Promise<string>;
  // The laid-out box of the first element a selector matches in the document. Read in an isolated
  // world, so page script cannot answer for it. Null when nothing matches. See ElementBox.
  boundingBox(selector: string): Promise<ElementBox | null>;
  screenshot(selector?: string): Promise<Buffer>;
  // Present only on a page opened by the judge's isolated browser: the distinct origins of the
  // requests it blocked since the page opened. A blocked script can remove the very control a
  // barrier sits on, so any entry here makes the screen a coverage gap.
  blockedRequests?(): Promise<string[]>;
}
// What Page.hostMarkup read about one element. Page text, so untrusted: a rule reads it to decide,
// and never copies it into a draft.
export interface HostMarkup {
  // Whether the custom element definition has loaded, the :defined pseudo-class. An element that
  // never upgraded has no shadow root and no inner control to read.
  defined: boolean;
  // Every attribute the element carries, by name.
  attributes: Record<string, string>;
  // The text of the child nodes that go to the default slot (text nodes, and elements with no slot
  // attribute or an empty one, with their descendants), whitespace collapsed. Text in a named slot is not counted.
  defaultSlotText: string;
}
export interface BrowserDriver {
  open(url: string): Promise<Page>;
  close(): Promise<void>;
}
export interface GitReader {
  writeTree(): Promise<string>;
  show(ref: string, path: string): Promise<string | null>;
  statusZ(): Promise<Array<{ code: string; path: string }>>;
  // Triple-dot diff reports merge-base -> HEAD changes, which keeps CI coverage honest on clean checkouts.
  diffNameOnly(ref: string): Promise<string[]>;
  lsTree(ref: string, paths: string[]): Promise<Record<string, string>>;
  lsFiles(ref: string, prefix: string): Promise<string[]>;
  headRef(): Promise<string>;
}
export interface FsGlob {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
}
export interface CheckRunner {
  // profile picks the per-surface provider configuration for this scan target. Absent means 'app'.
  scan(screen: { id: string; url: string; profile?: ProfileName }): Promise<ScreenScan>;
}
/**
 * Reads the debt history branch as git objects, never from a working tree. See src/history/.
 * The history can only lower the debt a run accepts, so a reader that returns nothing, or that a
 * caller leaves out, gives exactly the verdicts a run without history gives.
 */
export interface HistoryReader {
  // The ref the history is read from, for disclosures, for example "origin/usabl/history".
  readonly ref: string;
  // The commit a ref names, or null when there is no such ref.
  resolveCommit(ref: string): Promise<string | null>;
  // The file names at the top of a history commit.
  listFiles(commit: string): Promise<string[]>;
  // One file at a history commit, or null when it is not there.
  readFile(commit: string, path: string): Promise<string | null>;
  // Whether `commit` is `of` or one of its ancestors.
  isAncestor(commit: string, of: string): Promise<boolean>;
}

export interface Deps {
  clock: () => string;
  browser: BrowserDriver;
  git: GitReader;
  // The debt history reader. Absent means automatic tracking is off for this run, and it says so.
  history?: HistoryReader;
  fs: FsGlob;
  checkRunner: CheckRunner;
  runnerVersion: string;
  scannerVersions: ScannerVersions;
  // The design-intake bundle loaded once at build time (trusted-ref overlaid). The docs surface
  // reads this exact bundle so it never re-derives intake or drifts from what the run enforced.
  requirements: RequirementBundle;
}

// ---- config (operator file; engine does not hardcode origins) ----
export interface NoiseBudgetConfig {
  // Default maximum finding groups shown on bounded surfaces. Absent means 5.
  default?: number;
  // Per-screen overrides for calibration on large PatternFly surfaces. Each key is a screen id,
  // matched against one by exact comparison, so every key is checked against the shared id
  // grammar when the config is read.
  perSurface?: Record<string, number>;
}

// The object form of a surface's readiness signal. At least one part is declared.
export interface ReachedWhenSignal {
  // A CSS selector that must match at least one element in the rendered page. The string form of
  // reachedWhen is shorthand for this part alone.
  selector?: string;
  // A URL path, such as "/api/users". It holds when a fetch or XHR request the page made to the
  // application's own host (the appBaseUrl hostname or a subdomain of it, any scheme or port)
  // answered with a 2xx status, and the request path is this path or continues it after a slash.
  // The query string is not compared. A document or asset response never counts.
  response?: string;
}

export interface SurfaceConfig {
  id: string;
  url: string;
  files: string[];
  // Optional readiness signal: positive evidence that this screen really rendered. Either a CSS
  // selector string, or an object with a selector, a response path, or both. Every declared part
  // has to hold once the screen has loaded and the walk has run. If one does not, the screen is
  // marked unseen and its findings are dropped. Absent means the body-only floor and the session
  // rules are the only unseen detectors for this surface. See ReachedWhenSignal for each part.
  //
  // A signal that holds also overrides the password-field rule in providers/redirected.ts, and it
  // is what lets a refused request the application recovered from stand, so what it names
  // matters. This is operator-supplied policy, not independent proof: a selector aimed at a
  // persistent application shell, a header, a navigation, or a footer is present on a login wall
  // too, and it will let a wrong page through. Name content only this screen has, such as that
  // screen's own table, heading, or empty state, or a data request only this screen makes.
  reachedWhen?: string | ReachedWhenSignal;
  // Declares that this surface is the same screen as the discovered route with the same id, and
  // exists to control that screen's scan URL. Surface ids and route screen ids are one namespace,
  // so without this the planner cannot tell an intended URL override from two different screens
  // that happen to share a key. The planner refuses a surface whose id is also a discovered
  // route's screen id unless this is set. It never compares the two URLs, so the declaration is
  // needed even when they are the same, because a URL does not determine which screen renders.
  // Absent means false.
  overridesDiscoveredRoute?: boolean;
}
export interface UsablConfig {
  appBaseUrl: string;
  uiFileGlobs: string[];
  discovery: { routerFile: string; wideBlastGlobs: string[] };
  surfaces: SurfaceConfig[];
  requirements?: string;
  // Guarded paths can be files or directories. The trust guard expands directories so
  // edits cannot hide in newly added files under a listed prefix.
  guardedPaths: string[];
  promotedObligations?: string[]; // empty by default; listed classes may become deterministic voicing misses; the engine never writes this list
  // Whole-milliseconds budget for one screen to navigate, go quiet, and stop rendering. It lives
  // in operator config because how long an application takes to render is a property of that
  // application, not of the engine. Absent means the engine default.
  readyTimeoutMs?: number;
  // Whole-milliseconds cap on how long readiness waits for a screen's declared reachedWhen selector,
  // counted from the first moment the page settled and inside readyTimeoutMs. A screen whose
  // selector does not hold by then is a coverage gap and is not walked. Absent means the engine
  // default.
  signalTimeoutMs?: number;
  // Caps how many finding groups bounded surfaces show before collapsing by rule.
  noiseBudget?: NoiseBudgetConfig;
  // What to do when Chromium cannot start its sandbox on this system. auto, the default, scans
  // without it and says so in the run output and the Result. require refuses to scan: the run
  // ends with no verdict and exit 4.
  browserSandbox?: BrowserSandboxPolicy;
  // Settings for the CI judge. Read from the trusted ref only.
  judge?: JudgeConfig;
  // Optional commercial engines. Read from the trusted ref only. Absent or turned off means the
  // engine's provider is not registered at all, so a run without this block is the run usabl
  // made before engines existed.
  engines?: EnginesConfig;
}

// ---- optional commercial engines (the operator holds the license; the package is never a dependency) ----
// Their findings are preview in this release: shown, never gating. No key here can promote them.
export interface DequeEngineConfig {
  enabled: boolean;
  // Passed to Deque's builder as is. Absent means Deque's own default ruleset.
  rulesetId?: string;
  // Deque sends usage data unless told not to. Absent means false: usabl turns it off.
  trackUsage?: boolean;
}
export type EvincedMode = 'offline' | 'online';
export interface EvincedEngineConfig {
  enabled: boolean;
  // offline reads EVINCED_SERVICE_ID and EVINCED_AUTH_TOKEN and needs no license server.
  // online reads EVINCED_SERVICE_ID and EVINCED_API_KEY and contacts Evinced's license server.
  // Absent means offline.
  mode?: EvincedMode;
}
export interface EnginesConfig {
  deque?: DequeEngineConfig;
  evinced?: EvincedEngineConfig;
}

// Origins other than the app origin that the judge's isolated browser may reach, for example a
// font host. Each entry is a bare origin such as https://fonts.example.com. A branch cannot widen
// what its own scan may reach, because the judge reads this from the trusted ref.
export interface JudgeConfig {
  allowOrigins: string[];
}

// The values browserSandbox accepts.
export type BrowserSandboxPolicy = 'auto' | 'require';

export type Capability = 'live' | 'network' | 'secrets' | 'filesystem-write';

// The provider configuration a scan target selects. One run scans both surfaces, so the profile
// rides per scan target, not per run. Absent means 'app'; each provider reads ctx.profile ?? 'app'.
export type ProfileName = 'app' | 'docs';

export interface ProviderContext {
  page: Page;
  screen: { id: string; url: string };
  config: UsablConfig;
  profile?: ProfileName;
}

export interface Provider {
  id: string;
  layer: string;
  capabilities: Capability[];
  // Set when the provider clicks triggers or presses keys during its run. Every provider that runs
  // after one of these sees a page that is no longer the page the browser loaded.
  mutatesPageState?: boolean;
  // Set when the provider's evidence only holds on the page as it loaded, such as a walk of the
  // real focus order. Running it on a changed page yields thin or empty results that read as clean.
  requiresPristinePage?: boolean;
  // What this provider decides about a screen before any page opens, from the screen id and
  // profile alone. `usabl brief` prints it. The provider's run must agree: when this says the
  // provider does not apply, run reports nothing on that screen. Absent means the answer is only
  // known on the page.
  appliesBeforeScan?(screen: PlannedScreen): PlannedApplicability;
  run(ctx: ProviderContext): Promise<Draft[] | ProviderOutput>;
}

// A screen as the planner knows it before any page opens.
export interface PlannedScreen {
  id: string;
  profile: ProfileName;
}

// Whether a provider will check a screen, as far as that is known before the page opens. `why`
// is required when it does not apply, and says what decides it when it does.
export type PlannedApplicability = { applies: true; why?: string } | { applies: false; why: string };

// A provider that knows which rules applied returns them beside its drafts, from the same run.
// The union keeps providers with nothing to report on the plain Draft[] return, and it keeps
// applicability out of a second method: axe computes both in one analyze() call, and asking
// twice would mean a second full axe run per screen.
export interface ProviderOutput {
  drafts: Draft[];
  applicability?: RuleApplicability[];
  // A provider that isolates its own checks returns a disclosed gap for each check that failed,
  // so one failing check is scoped and named instead of dropping the whole provider's drafts.
  // runProviders merges these with the gaps it raises itself. Absent means the provider reported
  // no per-check failures, which is the honest reading of a provider that never sets it.
  gaps?: CoverageGap[];
  // Disclosures that never reach the gate. See ProviderNote. Absent means nothing to disclose.
  notes?: ProviderNote[];
}

export interface ProviderRunResult {
  drafts: Draft[];
  gaps: CoverageGap[];
  applicability: RuleApplicability[];
  notes: ProviderNote[];
}

// ---- gate I/O ----
export interface GateInput {
  coverage: Coverage;
  guardDivergedPaths: string[];
  drafts: Draft[];
  floor: EvidenceFloor;
  waivers: Waiver[];
  now: string; // clock() value, for waiver expiry
  // Screen ids the run measured with no coverage gap. A floored identity may be marked `fixed`
  // only when its screen is in this set, because a cleanly scanned screen with no barrier and a
  // screen nobody scanned both produce zero drafts, so absence of a draft alone cannot tell them
  // apart. Required, never optional: the gate must always be told which screens it may claim a
  // paid-down `fixed` about, so a caller cannot leave the question unanswered and get a false green.
  cleanlyScannedScreens: ReadonlySet<string>;
  // What each scanned screen showed of itself, by screen id. A cleanly scanned screen is still not
  // proof that the part of the page holding a floored barrier rendered: a screen whose header
  // mounted and whose content did not has no gap either. So a floored identity absent from the
  // drafts is marked `fixed` only when this shows the screen's readiness signal held or the
  // identity's own element was observed this run. Otherwise it is not claimed fixed, stays on the
  // floor as debt, and is disclosed in floorUnconfirmed. Absent, or a screen missing from the map,
  // means no such evidence, which is the safe reading: it can only withhold a `fixed`, never grant
  // one. Build it with renderEvidenceOf in src/gate/.
  renderEvidence?: ReadonlyMap<string, RenderEvidence>;
}
// What one scanned screen showed of itself. See GateInput.renderEvidence.
export interface RenderEvidence {
  // The surface declared a readiness signal and every declared part held.
  signalHeld: boolean;
  // Every element this run observed on the screen, through a keyboard stop or a draft, as the
  // slots identitySlot reads off an identity key: "path:<neutralized path>" and "name:<slug>".
  elementSlots: ReadonlySet<string>;
}
export interface GateOutput {
  verdict: Verdict | null;
  findings: Finding[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5; // 5 reserved; default install never emits it
  summary: string;
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  // Gaps the gate found while comparing the run with the floor: a floor that predates barrier
  // counting, whose placeholder counts cannot be compared at all.
  // The gate counts the floor, so only the gate can find these, and it has already weighed them into
  // the verdict and named it in the summary. A caller that assembles a Coverage for the Result
  // appends these so the gaps a reader sees match the gaps the verdict was reached from.
  floorGaps: CoverageGap[];
  // Floored identities the floor is ahead of. Disclosure only: this never moves the verdict.
  floorHeadroom: FloorHeadroom[];
  // Floored barriers absent on a cleanly scanned screen with no render evidence, per screen.
  // Disclosure only: this never moves the verdict. See FloorUnconfirmed.
  floorUnconfirmed: FloorUnconfirmed[];
}
