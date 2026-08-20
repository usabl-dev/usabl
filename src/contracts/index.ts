// ---- verdict + evidence vocabulary (ground-truth §5; preview added per A-evclass) ----
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type EvidenceClass =
  | 'deterministic'
  | 'preview'
  | 'model-judgment'
  | 'human-confirmed';
export type Verdict =
  | 'verified'
  | 'regression'
  | 'not_covered'
  | 'approval_required';
export type FactSource = 'ax-tree' | 'attribute';
export type IdentityBasis = 'name' | 'structural' | 'count';

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
export interface Draft {
  rule: string;
  layer: string; // contest ids: 'axe' | 'pf' | 'walk'; stays open
  severity: Severity;
  evidenceClass: EvidenceClass; // provenance taxonomy: only 'deterministic' (or promoted) mints
  //   the gate verdict; model-judgment/preview feed the judgment
  //   assessment + conformance summary (decision-log 8.2)
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
export interface Finding extends Draft {
  elementKey: string | null; // null when identityBasis is 'count'
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
}

// ---- announcement / transcript (voicing lane consumes these in Phase 4) ----
export interface AnnouncementToken {
  kind: 'name' | 'role' | 'state';
  text: string | null;
  fromTree: boolean;
  source: FactSource;
}
export interface TranscriptStop {
  index: number;
  elementPath: string;
  announcement: AnnouncementToken[];
}
export interface ScreenScan {
  screenId: string;
  url: string;
  stops: TranscriptStop[];
  drafts: Draft[];
}

// ---- coverage ----
export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual';
  importChain?: string[];
}
export interface CoverageGap {
  ref: string; // surface id, url, or file path this gap concerns
  state: 'unresolved' | 'not-covered' | 'skipped' | 'capability-denied';
  reason: string; // why it was not exercised; never empty (eqa-core: never report coverage that was not achieved)
}
export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[]; // each in-scope surface or check that could not be exercised, each with a reason (Phase 3 populates and consumes; Phase 1 leaves it [])
  nothingToCheck: boolean; // no UI-touching files; not a verdict
}
// Phase 1 note: the gate does not read coverage.gaps yet; it is a data channel that defaults to [] and is only counted by computeConformance. The gate's consumption of gaps is deferred to Phase 3.

// ---- receipt (ground-truth §5, §10) ----
export interface Receipt {
  schemaVersion: 1;
  sourceTree: string;
  baseRevision: string | null;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  surfaces: string[];
  coverage: { checked: string[]; notCovered: string[] };
  verdict: 'verified';
  findingsSummary: { new: number; carried: number; fixed: number; unverified: number };
  activeWaivers: number;
  signature?: string; // slot only; OIDC signing is a clean seam (A8)
  mintedAt: string;
}

// ---- the whole serializable output ----
export interface Result {
  schemaVersion: 'usabl.result.v1'; // versioned contract; every projection echoes it (ta borrow)
  verdict: Verdict | null; // null iff coverage.nothingToCheck
  summary: string;
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
}
// exitCode: 0 verified or nothing-to-check; 1 regression; 2 approval_required;
// 3 not_covered; 4 unhandled error (fail open with disclosure);
// 5 RESERVED for the opt-in judgment soft-gate (off by default; Phase 3+; decision-log 8.2).
//   The default install never emits 5; the deterministic gate stays exactly as above.

// ---- conformance summary (Fork 1b): a NON-GATING projection of Result, never a single score ----
// Always shows every bucket side by side; never hides the not-evaluated denominator. The gate
// verdict stays the authority; this is a read-only view for CI comments and the ACCESSIBILITY.md row.
export interface ConformanceSummary {
  verdict: Verdict | null; // echoes Result.verdict (the gate is the authority)
  blocked: boolean; // any in-scope deterministic new failure caps the summary
  deterministic: { newFailures: number; carried: number; waived: number; fixed: number };
  judged: { modelJudgment: number; preview: number }; // advisory provenance; never gates
  notEvaluated: { unresolvedFiles: number; gaps: number };
}

// ---- evidence floor + waivers (A2, A3) ----
export interface FloorEntry {
  screenId: string;
  layer: string; // contest: 'axe' | 'pf' | 'walk'
  rule: string;
  elementKey: string | null;
  identityBasis: IdentityBasis;
  count: number;
}
export interface EvidenceFloor {
  version: 1;
  entries: FloorEntry[];
}
export interface Waiver {
  rule: string;
  surface: string; // matches Finding.screenId
  scope: string; // matches Finding.elementKey, or '*' for the whole rule on the surface
  reason: string;
  owner: string;
  approvedBy: string;
  created: string; // ISO
  expires: string; // ISO; ignored once past
}
export interface WaiverLedger {
  version: 1;
  waivers: Waiver[];
}

// ---- interaction contracts (Phase 4 consumes; frozen day 1 per A-contract) ----
export interface Step {
  do: string;
  [key: string]: unknown;
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

// ---- design intake + docs output (Phase 6 consumes) ----
export type RequirementKind = 'content' | 'flow' | 'doc';
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
export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion: ContentAssertion | FlowAssertion | DocAssertion;
  owner?: string;
  approved: boolean;
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
  }>;
  generatedAt: string;
  boundToReceipt?: string;
}

// ---- injected dependencies (ground-truth §6) ----
export interface AxNode {
  name: string | null;
  role: string | null;
  states: Record<string, unknown>;
}
export interface ElementRef {
  selector: string;
}
export interface Page {
  gotoReady(): Promise<void>;
  focusBody(): Promise<void>;
  tab(): Promise<void>;
  press(key: string): Promise<void>;
  activeNode(): Promise<AxNode | null>;
  activePath(): Promise<string>;
  axAt(selector: string): Promise<AxNode | null>;
  queryAll(selector: string): Promise<ElementRef[]>;
  close(): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  setZoom(percent: number): Promise<void>;
  setReducedMotion(enabled: boolean): Promise<void>;
  getComputedStyle(selector: string, property: string): Promise<string>;
  screenshot(selector?: string): Promise<Buffer>;
}
export interface BrowserDriver {
  open(url: string): Promise<Page>;
}
export interface GitReader {
  writeTree(): Promise<string>;
  show(ref: string, path: string): Promise<string | null>;
  statusZ(): Promise<Array<{ code: string; path: string }>>;
  lsTree(ref: string, paths: string[]): Promise<Record<string, string>>;
  headRef(): Promise<string>;
}
export interface FsGlob {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
}
export interface CheckRunner {
  scan(screen: { id: string; url: string }): Promise<ScreenScan>;
}
export interface Deps {
  clock: () => string;
  browser: BrowserDriver;
  git: GitReader;
  fs: FsGlob;
  checkRunner: CheckRunner;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
}

// ---- config (ground-truth §22) ----
export interface SurfaceConfig {
  id: string;
  url: string;
  files: string[];
}
export interface UsablConfig {
  appBaseUrl: string;
  uiFileGlobs: string[];
  discovery: { routerFile: string; wideBlastGlobs: string[] };
  surfaces: SurfaceConfig[];
  requirements?: string;
  guardedPaths: string[];
  promotedObligations?: string[]; // empty by default (A-evclass)
}

// ---- gate I/O ----
export interface GateInput {
  coverage: Coverage;
  guardDivergedPaths: string[];
  drafts: Draft[];
  floor: EvidenceFloor;
  waivers: Waiver[];
  now: string; // clock() value, for waiver expiry
}
export interface GateOutput {
  verdict: Verdict | null;
  findings: Finding[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5; // 5 reserved for the opt-in judgment soft-gate (Phase 3+)
  summary: string;
}
