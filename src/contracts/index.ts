// ---- verdict + evidence vocabulary ----
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
export interface Finding extends Draft {
  elementKey: string | null; // null when identityBasis is 'count'
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
}

// ---- announcement / transcript (voicing lane; unused until that lane is wired) ----
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
  reason: string; // why it was not exercised; never empty
}
export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[]; // in-scope surfaces or checks that could not be exercised, each with a reason
  nothingToCheck: boolean; // no UI-touching files; not a verdict
}
// The gate does not read coverage.gaps yet. Gaps stay [] and are counted only by computeConformance.

// ---- receipt (re-checkable proof of a verified run) ----
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
  signature?: string; // reserved for later signed attestation; unused today
  mintedAt: string;
}

// ---- the whole serializable output ----
export interface Result {
  schemaVersion: 'usabl.result.v1'; // versioned contract; every projection echoes it
  verdict: Verdict | null; // null when idle (nothing to check) or when run() failed open (exit 4)
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
// 5 reserved for an opt-in judgment soft-gate (off by default). The default install never emits 5.

// ---- conformance summary: a NON-GATING projection of Result, never a single score ----
// Always shows every bucket side by side; never hides the not-evaluated denominator. The gate
// verdict stays the authority; this is a read-only view for CI comments and the ACCESSIBILITY.md row.
export interface ConformanceSummary {
  verdict: Verdict | null; // echoes Result.verdict (the gate is the authority)
  blocked: boolean; // any in-scope deterministic new failure caps the summary
  deterministic: { newFailures: number; carried: number; waived: number; fixed: number };
  judged: { modelJudgment: number; preview: number }; // advisory provenance; never gates
  notEvaluated: { unresolvedFiles: number; gaps: number };
}

// ---- evidence floor + waivers ----
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

// ---- interaction contracts (frozen now; voicing lane consumes later) ----
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

// ---- design intake + docs output (types frozen; producers not wired yet) ----
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

// ---- injected dependencies (all I/O enters here; run() has none of its own) ----
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

// ---- config (operator file; engine does not hardcode origins) ----
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
  guardedPaths: string[]; // file paths only; directories are not expanded by guard divergence
  promotedObligations?: string[]; // empty by default; promotion is not wired yet
}

export type Capability = 'live' | 'network' | 'secrets' | 'filesystem-write';

export interface ProviderContext {
  page: Page;
  screen: { id: string; url: string };
  config: UsablConfig;
}

export interface Provider {
  id: string;
  layer: string;
  capabilities: Capability[];
  run(ctx: ProviderContext): Promise<Draft[]>;
}

export interface ProviderRunResult {
  drafts: Draft[];
  gaps: CoverageGap[];
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
  exitCode: 0 | 1 | 2 | 3 | 4 | 5; // 5 reserved; default install never emits it
  summary: string;
}
