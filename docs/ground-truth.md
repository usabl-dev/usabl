# usabl: consolidated design

Status: working draft. Author: eparenti. August 2026.

This is the project ground truth for the usabl product. It is one document that covers
the check-agnostic core, evidence labels, design intake, Reports, and the on/off
adoption model.

This document describes usabl v0.2.2: an Apache-2.0 accessibility proof engine, published
as ESM, requiring Node >=22, with a single bin `usabl` mapped to `./dist/cli.js`. Its
library exports are `usabl`, `usabl/vite`, `usabl/webpack`, `usabl/playwright`, `usabl/docs`,
and `usabl/measure`, each listed in the `exports` field of `package.json`. Where this
document and the source disagree, the source is authoritative.

---

## 1. Product thesis and name

**Name:** usabl. Tagline: "usable by default." Supporting line: "don't ship until
it's usabl."

**Problem.** AI tools now write a large share of UI screens, and they often build
things a screen reader cannot use. A scanner on its own points out problems; it does
not confirm a fix worked, and on its own it does not stop the AI from calling work "done"
when a screen reader still cannot use it. Meanwhile, James uses a screen reader daily
and waits releases for fixes. Priya builds the UI with great intentions but misses
things because it is hard to know everything.

**What usabl is.** A proof engine for accessibility in product development workflows.
It checks whether the screens mapped from the changed UI files have any machine-checkable
accessibility barrier that is new against a reviewed evidence floor and not covered by an
active waiver, before work can be called done. When it checked something, it gives one of
four answers (a run that checked nothing, or that crashed, gives no verdict; see below):

| Verdict | Meaning |
|---|---|
| `verified` | No new distinguishable identity, and no count growth at a recorded one, under the reviewed floor and outside active waivers, on the screens mapped from the changed UI files. |
| `regression` | A new problem appeared. |
| `not_covered` | Could not identify or exercise what the change touched. |
| `approval_required` | Policy changed; the tool will not judge itself. |

The AI can suggest fixes. It does not get to grade its own work.

Idle is not a fifth verdict. When there is no UI-touching change, usabl allows with
an explicit informational outcome: `Result.verdict` is `null`, exit 0, no findings,
and `summary` says "nothing to check." `not_covered` means there *was* something to
prove and the tool could not. A change that touches no covered surface (no UI files,
and no documentation page under a `usabl.docs.json` manifest) is idle, not `not_covered`.

`verdict: null` is overloaded, so it is never treated as a verdict. It means either idle
(`coverage.nothingToCheck` is true, exit 0) or a crash and fail-open (exit 4, disclosed,
`nothingToCheck` false). The two are distinguished by `coverage.nothingToCheck`, not by
the null itself.

**The gate always decides. Surfaces choose whether to enforce.** Overlay and the
advisory lane display the Result without blocking. The stop hook enforces. CI
enforces only when the `usabl-required` check is a required status (branch protection or
a ruleset). On this repository it is required by the main-branch ruleset.

**One check, several places it shows up.** The same engine runs behind all of these.
Every surface is a thin wrapper over one CLI entry point that returns `Result`.

| Surface | Value (why it exists) |
|---|---|
| **CLI** | Run the full engine on demand: baseline a brownfield app, debug locally, CI invokes this, and the agent mid-task self-check (`usabl check` via Bash). Scanner-shaped entry, proof-engine semantics. |
| **Stop hook** | Block the AI's first stop on a blocking verdict unless a one-use bypass was issued. The headline. |
| **Overlay** | Show findings while hand-coding in the browser. Advises only. |
| **CI / PR comment** | Team-visible gate on merge. Policy read from the trusted base ref. |
| **Mid-task self-check** | Let the agent check itself while context is warm, before Stop. **CLI is sufficient** (Bash); MCP is an optional transport for discoverability (section 11.5). Stop still decides. |
| **Reports** | Publish approved accessibility artifacts (alt-text manifests, snippets, keyboard paths) bound to verified evidence. Command: `usabl docs`. |
| **Playwright helper** | Same check inside tests teams already run. |

v0.2 builds CLI, stop hook, overlay, CI, Reports, and mid-task self-check via
CLI. An MCP wrapper is optional and not built (section 11.5); add it only if
discoverability matters.

**One engine, two target surfaces.** The table above is about *where the engine runs*.
On the other axis, *what it checks*, usabl covers two surfaces with the same engine and
one verdict, or none: the application UI (sections 7-8) and, since v0.2.1, the product's own
documentation pages (sections 3, 7.6, 8). Documentation checking is not a second product
or a separate command; it is the same `usabl check` run over a second set of scan targets.

---

## 2. What is new

The core idea: a scanner gives advice a human may or may not read. usabl's gate decides,
and the stop hook blocks the AI's first stop on a blocking verdict unless a one-use bypass
was issued, so a machine-checkable barrier that is new against the reviewed floor on the
mapped screens is not called done in silence. The overlay and the advisory lane still show findings without
blocking. That is display, not a second decision-maker.

The specific things that are new, each against what exists today:

1. It re-checks the change as well as finding the problem. usabl compares the next run
   against the floor and reports what it no longer observes. It observes absence; it
   does not witness the fix.
2. It discloses every gap it detected. It reports "we could not check this" as a real
   answer instead of quietly passing.
3. A verified answer can be re-checked. A verified receipt is bound to the exact source
   tree, policy, runner version, and scanner versions, and re-verification compares those
   bindings against the current tree without a re-scan.
4. It shows what a screen reader would actually say, on the change. Simulating
   screen-reader output is a gap the field names itself, and surfacing that
   announcement as re-checkable evidence on a code change is new. The preview is
   current-run today; an automated before/after diff against a base run is a planned
   follow-up, not a v0.2.0 claim.
5. It has rules for a real design system. usabl ships composition rules for PatternFly,
   an open-source design system used across many enterprise products.
6. The rules cannot be silently weakened. Locally, policy edits are tamper-evident and
   leave a reviewable commit trail (`approval_required`). In CI with trusted-ref reads
   and required checks, policy tampering is blocked before merge.

What is honestly not new: general scanning exists, and blocking only new problems
against a baseline exists. The CLI can be invoked like a scanner on an existing
codebase (`usabl check`), but that is adoption plumbing, not the product claim. A
scanner reports findings; usabl decides a verdict, diffs against a floor, and its Stop
hook blocks the first stop on a blocking verdict (unless a one-use bypass was issued or the
host reports that continuation is already active). The design goal is putting all of
that into one loop that gates an AI on evidence you can re-check and that is grounded in
what a screen reader actually hears.

---

## 3. Scope

### Built in v0.2

- The check-agnostic core (gate, coverage, guard, receipts, evidence labels).
- Three scan layers behind one provider interface: axe-core, PatternFly rulepack,
  pattern-aware keyboard walk.
- Surfaces: CLI, stop hook, overlay, CI/PR comment, Playwright helper, mid-task
  self-check (CLI). CI, overlay, and hooks all call the same engine core; no MCP
  surface is built.
- Reports (accessible docs output): generate alt-text manifests, announcement snippets,
  and keyboard paths, bound to the receipt.
- Evidence labels on every Draft (`evidenceClass`). In v0.2 everything is
  `deterministic`.
- Design intake: RequirementBundle schema and YAML normalize. Wiring intake-derived
  providers is in v0.2 scope; ingesting Figma/CSV is a seam.
- Page capabilities wired in the deps interface (viewport, zoom, reduced motion,
  computed style, screenshot) even though the default checks do not use them.

Overlay and Reports are built. Mid-task self-check is built via the CLI. The MCP
wrapper is optional: add it only if agent discoverability in Claude Code is worth a
fourth transport (section 11.5).

### Documentation checking (shipped in v0.2.1)

usabl checks two target surfaces, not one: the application UI and the product's own
documentation pages. This shipped in v0.2.1, after the scope above was written,
and it reuses the same engine rather than adding a second product. One `usabl check`
run scans both surfaces and returns one verdict, or none; there is no separate docs command and
no `--docs` check flag.

- Activation: a `usabl.docs.json` manifest. Absent means no docs surface; present means
  the run scans the pages it lists. The manifest is a guarded policy file.
- Profile: each scanned documentation page carries `profile: 'docs'`. Providers read
  `ctx.profile ?? 'app'` and adjust (section 7.6): axe-core scopes to the WCAG 2.2 AA
  tag set, the docs-content rulepack adds `docs-heading-order`, the keyboard walk runs
  unchanged, and the PatternFly rulepack is a no-op.
- Coverage: a changed `.adoc` file maps to the pages whose source closure includes it,
  built from real `include::` transclusions (section 8). Unmapped `.adoc` files are
  honest `not_covered`, not silent passes.
- Source-aware findings: a finding on a rendered page is mapped back to its AsciiDoc
  source so a writer sees the fix in their own markup, not a DOM selector. The mapping
  is presentation-only and never gates.
- Onboarding: `usabl init --docs` drafts the manifest for a detected docs format
  (Pantheon/modular AsciiDoc, OpenShift AsciiBinder); `usabl install --docs-ci` writes
  a docs gate workflow; `usabl baseline` floors existing docs debt alongside UI debt.

Do not confuse this with Reports (section 14): checking scans docs for barriers, while
Reports generates publishable artifacts from a verified run.

### Bloat-proof rule

Add a surface or provider only when it solves a problem nothing else solves. Every
surface wraps `run()` → `Result`; it does not reimplement gate logic. If two surfaces
would show the same Result the same way, keep one. Later seams are documented
so the architecture is extensible; they are not a commitment to build everything.

**Explicitly out:** IDE extensions and LSP diagnostics. The dev-server overlay covers
hand-coding in the browser; the CLI covers on-demand runs. A separate editor plugin
duplicates both without a new verdict path.

### Stretch (deterministic, candidates once the core is solid)

- Visible focus indicator (WCAG 2.4.7).
- Reduced motion respected (preference injection; not a 2.2 A+AA row of its own).

Do not add these to the fixture oracle. Delete them if they destabilize the loop.

### Easy to add later (deterministic checks we can call verified)

- Text resize and reflow at 200 percent.
- Target size for touch and pointer.
- Consistent navigation across screens.
- Captions present.

Each is a new provider returning `Draft[]` with `evidenceClass: 'deterministic'`.
The page capabilities are already wired; adding a check never touches the gate.

### Advisory lane (model-judgment, never verified)

A separate, clearly labeled lane where a model judges meaning and a person decides:

- Plain language and reading level.
- Whether alt text actually says something useful.
- Whether link text, headings, and error messages are clear.

These produce `Draft[]` with `evidenceClass: 'model-judgment'`. They are surfaced in
the overlay, the PR comment, and the CLI. They never block. They never produce
`verified`. A person decides.

### What this product will never do

- Certify legal or regulatory compliance. It supports the work, it does not sign it off.
- Detect seizure risk from flashing. That is frame-by-frame signal analysis, a
  different tool.
- Prove application logic like time limits, which it does not run over time.
- Replace a real screen-reader user or an accessibility expert. It shrinks what a
  human must check, it does not remove the human.
- Claim a screen is accessible for everyone. It verifies what its checks cover, on
  the screens it checked, and says which is which.

---

## 4. Architecture

### Five architectural decisions

These make "easy to add later" real. They are non-negotiable constraints on the build.

1. **Keep the deciding part simple and general.** The gate, coverage, guard, and
   receipt engine works with nothing more than a plain list of Drafts. It does not know
   or care what kind of problem a Draft describes. Adding a new kind of check never
   means touching the part that decides the answer.

2. **Every check just reports problems. Only the core decides.** A screen-reader check,
   a contrast check, and a future layout check all hand back the same shape: `Draft[]`.
   None of them gets to decide the verdict. That stays with the gate.

3. **Label each problem with what kind of evidence it is.** On every Draft, a label:
   `deterministic` (a hard, repeatable check), `preview` (an approximation that is
   useful in the loop but is not a screen reader), `model-judgment` (an AI model's
   assessment), or `human-confirmed` (something a person verified). `preview` is a
   fourth provenance class, not a fifth verdict. Word-matching announcement drafts are
   `preview` by default. A human can promote a listed class in config; the engine never
   promotes itself.

4. **Only deterministic checks can produce a verified.** The gate filters on
   `evidenceClass` before computing the verdict. Preview, model-judgment, and
   human-confirmed findings are surfaced but never count toward or against `verified`.
   One of them can never slip into a verified answer by accident.

5. **Give the page tool a few extra abilities now.** Even though the default checks do
   not use them yet, the Page interface supports changing the zoom and window size,
   reading computed styles, taking a screenshot, and enabling reduced-motion preference.
   Setting these up now is what makes later checks cheap to add.

### Module map

This is the actual source layout as built for v0.2.2. Dedup is not a separate module;
it runs inside the gate (see section 9). There is no built MCP surface (section 11.5);
an MCP wrapper stays an optional transport.

```
src/
  contracts/        index.ts
  primitives/       canonical.ts identity.ts iso8601.ts match-glob.ts neutralize.ts slug.ts sortKey.ts
  deps/             build.ts real.ts ax-tree.ts fakes.ts fs.ts git.ts
  providers/
    axe/            index.ts notes.ts
    rulepack/       index.ts probes.ts selectors.ts pf-<one-file-per-static-rule>.ts
    rhds/           index.ts sources.ts draft.ts rhds-<one-file-per-rule>.ts
    design-system-pack.ts   (design-system markers and the inapplicable record; section 7.2)
    docs-rulepack/  index.ts heading-order.ts
    keyboard-walk/  index.ts steps.ts
    check-runner.ts index.ts
  evidence/         receipt.ts floor.ts
  coverage/         import-graph.ts planner.ts route-manifest.ts docs-manifest.ts docs-planner.ts asciidoc-include-graph.ts
  gate/             index.ts
  trust/            guard.ts
  intake/           schema.ts normalize.ts load.ts config.ts load-config.ts trusted-config.ts map-to-providers.ts overlay-fs.ts
  docs/             alt-text-manifest.ts announcement-snippets.ts keyboard-paths.ts evidence-binding.ts source-map.ts
  output/           conformance.ts summary.ts
  doctor/           index.ts
  brief/            index.ts   (usabl brief: the task-start brief; measurement only, section 11.5)
  drift/            routes.ts
  floor/            prune.ts
  init/             index.ts docs/index.ts docs/asciidoc-modular.ts docs/asciibinder.ts
  baseline/         index.ts
  session/          index.ts   (usabl session: sign in once, save the storage state)
  install/          overlay.ts claude.ts ci.ts history-ci.ts branch-rule.ts index.ts
  history/          record.ts read.ts track.ts tracking.ts append.ts git.ts record-run.ts report.ts
                    ledger.ts ledger-git.ts ledger-report.ts   (usabl debt ledger; measurement only, section 9)
  voicing/          voicing.ts structural.ts virtual-sr-provider.ts normalize.ts silent-change.ts tree-change.ts   (runs voice requirements and the silent change rule; section 7.5)
  measure/          fleet-insights.ts   (measurement-only; not in the run/gate path; section 25)
    sensitivity/    catalog.ts rules.ts targets.ts edits.ts browser.ts runner.ts level1.ts level2.ts attestation.ts command.ts   (usabl verify sensitivity; measurement only; section 25)
  surfaces/
    cli.ts pr-comment.ts policy-enforce.ts scrub.ts receipt-store.ts
    stop-hook.ts stop-hook-runner.ts stop-hook-bin.ts
    overlay-host.ts vite-plugin.ts webpack-plugin.ts webpack-loader.ts overlay-client.ts
    playwright-helper.ts
    self-check.ts docs.ts docs-html.ts
  run.ts cli.ts cli-bin.ts index.ts
fixtures/
test/
usabl.config.json
usabl.routes.json
usabl.docs.json
.usabl-evidence.json
.usabl-waivers.json
.github/workflows/usabl.yml        (engine dogfood CI: gitleaks, pre-commit, semgrep, npm run check)
.github/workflows/usabl-gate.yml   (engine PR gate; see section 11.4)
```

### Check-agnostic data flow

```
Providers (axe, rulepack, docs-rulepack, walk, intake-derived, future)
    │
    │  each returns Draft[] with evidenceClass
    ▼
Gate (the single verdict authority)
    │  filters: only evidenceClass=deterministic counts
    │  applies: identity, dedup across layers, differential, waivers
    │  computes: verdict
    ▼
Result (the whole serializable output)
    │
    ├── CLI (run on demand; all other surfaces call this)
    ├── Stop hook (block/allow)
    ├── Overlay (show; same engine, does not block)
    ├── CI/PR comment (comment; block merge when required)
    ├── Playwright helper (return Result)
    ├── Mid-task self-check (CLI; optional MCP transport)
    └── Reports (publish artifacts)
```

---

## 5. Contracts

These are the shapes that cross module boundaries. Freeze them day 1. Every list is
sorted by a stable key before it is hashed or snapshotted.

```ts
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
// Evidence class is provenance, not authority. Preview and model-judgment never gate.
export type EvidenceClass =
  | 'deterministic'
  | 'preview'
  | 'model-judgment'
  | 'human-confirmed';
export type Verdict = 'verified' | 'regression' | 'not_covered' | 'approval_required';
export type AccessibilityVerdict = Exclude<Verdict, 'approval_required'>;
export type AccessibilityExitCode = 0 | 1 | 3 | 4;
export type FactSource = 'ax-tree' | 'attribute';
export type IdentityBasis = 'name' | 'structural' | 'count';

export interface Fact<T = string | null> {
  value: T;
  source: FactSource;
  fromTree: boolean;              // not the verdict word `verified`
}

export interface EvidenceFacts {
  name?: Fact;
  role?: Fact;
  state?: Record<string, Fact<unknown>>;
  extra?: Record<string, unknown>;
}

export interface Draft {
  rule: string;
  layer: string;                  // open; built-in layers are `axe` | `pf` | `walk`
  severity: Severity;
  evidenceClass: EvidenceClass;   // the seam
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
  elementKey: string | null;      // null when identityBasis is `count`
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
}

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
  // Set only when the body had focus at this stop. The blank-page detector reads it, because a
  // body with an id has that id as its path.
  onBody?: true;
}

export interface ScreenScan {
  screenId: string;
  url: string;
  stops: TranscriptStop[];
  drafts: Draft[];
  gaps: CoverageGap[];
  notes?: ProviderNote[];          // every engine scan sets it; absent reads as no notes
}

// A provider's disclosure about a screen, for example design-system markup its rules did not
// read. Disclosure only: never a verdict input and never a coverage gap. The gate never reads
// it, so it cannot block a screen or mark one checked. Engine words and counts, no page text.
// Providers return notes in ProviderOutput.notes beside drafts, applicability, and gaps.
export interface ProviderNote {
  ref: string;                     // provider:<pack id>/<subject>
  reason: string;
}

export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual';
  importChain?: string[];
  reason?: string; // wide blast from a dependency change only: names each file and why it counts
}

export interface CoverageGap {
  ref: string;
  state: 'unresolved' | 'not-covered' | 'skipped' | 'capability-denied';
  reason: string;
}

export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[];
  nothingToCheck: boolean;        // no UI-touching files; not a verdict
  excludedFiles?: ExcludedFile[]; // disclosure only: test files nothing usabl found can load
  discoveryNotes?: DiscoveryNote[]; // disclosure only: what screen discovery had to assume
}

// A changed file that matches uiFileGlobs but that the planner left out on purpose. Today that is
// a test file (named like a test, or in a test folder) that no file outside the tests imports and
// no import usabl could not follow could load. Not a gap: the gate never reads it. Absent and
// empty both mean nothing was excluded.
export interface ExcludedFile {
  ref: string;    // repository path
  reason: string; // why it was left out, and what would make it count
}

// What screen discovery had to assume, about one file. Today that is an alias import that the
// app configs and the repository root configs map to different places, which usabl follows both
// ways when a changed file is reached through it. Not a gap: the gate never reads it. Absent and
// empty both mean nothing to disclose.
export interface DiscoveryNote {
  ref: string;    // repository path of the importing file
  reason: string; // what was assumed, and what would remove the doubt
}

export interface Receipt {
  schemaVersion: 2;
  sourceTree: string;             // the tree read before planning, unchanged after the scan
  baseRevision: string | null;
  historyHead: string | null;     // the debt history commit the run read
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string; engines?: Record<string, string> };
  surfaces: string[];
  coverage: { checked: string[]; notCovered: string[] };
  applicability: { screenId: string; applied: number; abstained: number }[];
  verdict: 'verified';
  findingsSummary: { new: number; carried: number; fixed: number; unverified: number };
  activeWaivers: number;
  waiverExpiresAt?: string | null; // earliest end of the waivers applied; absent on older receipts
  signature?: string;             // reserved for later signed attestation; unused today
  mintedAt: string;
}

export interface Result {
  schemaVersion: 'usabl.result.v1';
  verdict: Verdict | null;        // null when idle or fail-open disclosure
  summary: string;                // for idle: "nothing to check"
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  paidDownCount: number;          // floor entries whose barrier this run did not observe on
                                  // a cleanly scanned screen; not a count of fixes;
                                  // projection only, never gates
}

// exitCode: 0 verified or nothing-to-check; 1 regression; 2 approval_required;
// 3 not_covered; 4 unhandled error (fail open with disclosure);
// 5 reserved for an opt-in judgment soft-gate (off by default). The default install never emits 5.
// accessibilityExitCode is the same scale without 2. CI uses it for the accessibility
// required check so an approved policy change can merge without turning the Result green.

// Design intake
export type RequirementKind = 'content' | 'flow' | 'doc' | 'voice';

export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion: ContentAssertion | FlowAssertion | DocAssertion | VoiceAssertion;
  owner?: string;
  approved: boolean;
}

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

export interface VoiceAssertion {
  type: 'voice';
  steps: Step[];                   // the interaction contract steps
  obligations: SpeechObligation[]; // what a screen reader user must hear, per step window
  maxTabPath?: number;
}

export interface RequirementBundle {
  version: 1;
  requirements: Requirement[];
}

// Reports (accessible docs output)
export interface DocArtifact {
  kind: 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths';
  surface: string;
  entries: Array<{
    element: string;
    content: string;
    status: 'draft' | 'approved';
    evidenceRef?: string;
    origin?: 'page';               // drafted from the page; always a draft, never evidence
  }>;
  generatedAt: string;
  boundToReceipt?: string;
}
```

---

## 6. Injected dependencies

The engine is a pure function over data plus this Deps object. Real implementations
live in `deps/real.ts`, in-memory fakes in `deps/fakes.ts`. Every test runs on fakes.

```ts
export interface Deps {
  clock: () => string;
  browser: BrowserDriver;
  git: GitReader;
  fs: FsGlob;
  checkRunner: CheckRunner;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  requirements: RequirementBundle; // intake bundle loaded once at build time (trusted-ref overlaid)
}

export interface BrowserDriver {
  open(url: string): Promise<Page>;
  close(): Promise<void>;
}

export interface Page {
  gotoReady(): Promise<void>;
  focusBody(): Promise<void>;
  tab(): Promise<void>;
  press(key: string): Promise<void>;
  click(selector: string): Promise<void>;
  activeElementIs(selector: string): Promise<boolean>;
  activeElementWithin(selector: string): Promise<boolean>;
  armAnnouncementCapture(): Promise<void>;
  drainAnnouncements(): Promise<string[]>;
  activeNode(): Promise<AxNode | null>;
  activePath(): Promise<string>;
  // The browser's node id for the focused element, or null. It stays the same while the element
  // is in the document, so the keyboard walk can tell a moved control from a new one.
  activeElementKey(): Promise<string | null>;
  axAt(selector: string): Promise<AxNode | null>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  // Named attributes of the element and each element above it, nearest first, along the flat tree,
  // through open and closed shadow roots. Also reports an element it could not find and a walk that
  // stopped at 512 elements.
  ancestorAttributes(selector: string, names: readonly string[]): Promise<AncestorAttributesRead>;
  queryAll(selector: string): Promise<ElementRef[]>;
  close(): Promise<void>;
  // Capabilities wired for future checks (not used by the built-in providers)
  setViewport(width: number, height: number): Promise<void>;
  setZoom(percent: number): Promise<void>;
  setReducedMotion(enabled: boolean): Promise<void>;
  getComputedStyle(selector: string, property: string): Promise<string>;
  screenshot(selector?: string): Promise<Buffer>;
}

export interface AxNode {
  name: string | null;
  role: string | null;
  states: Record<string, unknown>;
}
export interface ElementRef { selector: string; }

export interface GitReader {
  writeTree(): Promise<string>;
  show(ref: string, path: string): Promise<string | null>;
  statusZ(): Promise<Array<{ code: string; path: string }>>;
  diffNameOnly(ref: string): Promise<string[]>; // merge-base..HEAD changed files
  lsTree(ref: string, paths: string[]): Promise<Record<string, string>>;
  lsFiles(ref: string, prefix: string): Promise<string[]>;
  lsFilesUnder(ref: string, prefixes: string[]): Promise<string[]>; // one -z listing; '' is the whole tree
  headRef(): Promise<string>;
}

export interface FsGlob {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
}

export interface CheckRunner {
  scan(screen: { id: string; url: string }): Promise<ScreenScan>;
}
```

---

## 7. Scan layers

Three layers, one `Provider` interface. The gate does not know or care how many
providers exist.

```ts
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
```

The rulepack does not use a separate `RuleModule` type. Each PatternFly rule is a plain
function `(ctx: ProviderContext) => Promise<Draft[]>` that the provider composes; see
section 7.2.

### 7.1 axe-core provider

Wraps axe-core so it returns `Draft[]`. It owns color contrast, alt text, and general
WCAG-mapped checks. A curated notes table overrides axe's default `why`/`fix` text for
common rules with plain-language PatternFly-specific guidance. Every Draft has
`evidenceClass: 'deterministic'`.

axe runs in an isolated world in every frame (`src/deps/axe-world.ts`), not in the page's own
world. An isolated world shares the DOM with the page but not its globals or prototypes, so page
script that patches `getAttribute` or defines a `window.axe` getter does not change axe's selectors
or results. The frame walk is the one `@axe-core/playwright` does: `axe.runPartial` in each frame,
child frames found through axe's own frame contexts, a frame in another process reached through its
own CDP session, and `axe.finishRun` in the top frame's world. A child frame axe cannot be loaded
into or run in, because a step ran out its 60 second budget, the frame was sandboxed without
scripts, it was removed or navigated while axe ran, or no session reached it, is a `not-covered`
gap named by the frame's origin and the reason. So is a frame whose list of frames changed between
axe's read of it and its run, since axe would then place one frame's results under another, and a
frame whose partial result is not an object. A top frame where either happens, or a final result
that is not an axe result, fails the whole axe run, which is a gap for the screen. After the walk,
usabl compares the frames it checked with the browser's frame trees. A frame axe never found, such
as an iframe in a closed shadow root, a document in an `object` or `embed` element, or a frame
added while axe ran, is a `not-covered` gap too, unless the accessibility tree ignores its frame
element, which is how axe skips a hidden frame. axe's own Playwright runner dropped all of these
without a gap, and gave a child frame one second to load axe. A frame added after that comparison
is not seen.

axe reads the semantics a custom element sets through `ElementInternals` from page-world properties
such as `_internals`, which an isolated world cannot see. usabl gives axe what the browser's
accessibility tree computed for each custom element instead: its role, when the element has no role
attribute, the tree exposes a role that is not generic, and Chrome could not have derived that role
from the element's own layout or focus, a name set through an internals `aria-label`, and the
states axe's `aria-required-attr` rule asks for. The tree reports a default state, such as
unchecked, whether or not the element set one, so a state reaches axe only when the element has no
attribute for it and the tree reports a value other than the role's default: checked or mixed,
expanded, a heading level other than 2, and a slider, scrollbar, separator, or meter value other
than the one the browser supplies when none is set. A state set through internals to its default
value is not carried, so usabl can report it as missing, never the reverse.
`test/deps/axe-world.real.integration.test.ts` pins in Chrome the default each of these states
reports when an element sets none. Chrome gives a custom element a role of its own from a `display:
list-item` or table display, from CSS `content`, from being a `focusgroup` owner, and a group role
from focus, `popover`, `autofocus`, `draggable`, or an ARIA relation (`RoleFromLayoutObjectOrNode`
in Chromium's `ax_node_object.cc`). usabl reads those facts in its own world and carries no role
they could explain, so a list of elements displayed as list items fails as it does in the page
world. A role set through internals on such an element is dropped too, which can report a barrier
the page world did not, never the reverse. On the comparison fixtures this matches axe in the page
world for list items, buttons, tabs, headings, labelled form controls, a state on an element with a
role attribute, images, hidden items, lists in shadow roots, and each carried state on its own
page, set and not set, and on the pages with list-item, table, focus, and CSS content layouts and
no internals at all. Four cases differ, and all are recorded in
`test/deps/axe-world-compare.summary.json`. A list item set through internals on an element
displayed as a list item has its role dropped, so usabl reports the list as missing its items. A
heading that sets level 2 through internals reads like one that sets no level, so usabl reports its
level as missing where the page world did not. A role kept in a private field is invisible to axe
in the page world, which then reports a list with no items; the browser exposes the items, and so
does usabl. A role attribute of `presentation`, or one that is not a role, overrides the internals
role in Chrome, which then exposes no list items. usabl reports the list as missing its items; the
page world read the internals role and passed it, which was a false pass.

A color-contrast result axe could not measure because the element's background is a
gradient is still a needs-review draft (`confidence: 'unverified'`) with the same rule,
element, severity, and evidence. It is the result whose `color-contrast` check data has
`messageKey: 'bgGradient'`, the axe-core 4.13.0 reason for a background gradient, matched
exactly. Only its words differ: it says axe could not measure the contrast because the
background is a gradient, and that a person should check the text against the lightest
and the darkest part of the gradient (4.5:1, or 3:1 for large text). PatternFly 6 buttons
draw a gradient, so a screen can carry many of these. The terminal summary prints them as
one entry per screen and status, with the count and every element path, each followed by
the source or candidate lines that element's finding carries, after the other findings in
the same list. The collapsed views (pull request comment, Stop hook, self
check) give them a group of their own, so they never merge with a contrast result axe did
measure. Every other contrast result, including other needs-review reasons, is printed as
before. None of this changes a finding, an identity, the floor, a verdict, an exit code,
or a receipt: new ones still block as not covered, and recorded ones still do not. `usabl
check --json` lists each one as its own finding.

### 7.2 PatternFly rulepack

The provider id is `pf-rulepack` (layer `pf`). It emits eight named rules: six static
checks (one file per rule) and two interaction probes (`pf-focus-into-dialog` and
`pf-modal-focus-return`, both in `probes.ts`). They return drafts. `pf-toast-live-region`
also returns a gap for each alert it could not check:

1. `pf-toast-live-region`: toasts, alert groups, inline validation, and async table
   loading must sit in a role=status/alert/aria-live region that exists before the
   update. The check resolves each alert's effective live value the way WAI-ARIA
   defines it: the value on the nearest element that sets one, explicitly through
   `aria-live` or implicitly through its role (alert is assertive, status and log are
   polite, timer and marquee are off). The explicit attribute wins over the role on
   the same element. The check never passes an alert that a browser or screen reader
   may keep silent, and the token rules follow from that. Only the exact lowercase
   `aria-live` tokens `polite` and `assertive` are live. Every other non-empty value,
   such as `POLITE`, `OFF`, or `banana`, is off and stops the walk. WAI-ARIA 1.2 does
   not map an unknown value to the default: it tells browsers to expose it as
   written, and Chromium 151 does, so `aria-live="POLITE"` reaches the screen reader
   as `POLITE`. Reading such a value as off can only make an alert less live. An empty
   `aria-live` counts as not set, as it does in Chromium. Role names match without
   regard to ASCII case, as Chromium matches them. WAI-ARIA leaves role case to the
   host language, and exact-case matching would be unsafe here: it would skip
   `role="TIMER"`, whose implicit value is off, and pass the alert on a polite region
   above it. A role list uses its first recognized role. The walk follows the flat
   tree, so a slotted alert climbs through its slot. It runs over CDP in an isolated
   world, so it sees slots inside closed shadow roots, which page script cannot, and a
   page that redefines `assignedSlot` or `parentNode` cannot change what it reads. An
   alert passes only when the nearest value above it is polite or assertive, the
   alert does not set off on itself, and neither the alert nor anything above it hides
   its subtree from assistive technology with `aria-hidden`, `inert`, or `hidden`, by
   the same rule the announcement capture applies. A live region inside such content
   announces nothing, so the alert fails there, and the draft says it is hidden. The
   ancestor read returns attributes and not tag names, so a closed `dialog` element
   above the alert is not seen here. The fix for that case says to remove `aria-hidden`,
   `inert`, or `hidden` from the alert and the elements above it. One case is the modal
   pattern working as intended: a PatternFly modal sets `aria-hidden="true"` on the app
   root, a child of the body, while it is open, and the live region works again when it
   closes. So when the only hidden element in the chain is the body's child, and a modal
   dialog is open outside it, the alert is judged by its live region alone, as with no
   modal open. A modal counts as open when it is a `dialog` in the browser's `:modal`
   state, or an element whose role and `aria-modal` make it a modal dialog, and it is in
   the accessibility tree. The rule knows which entry of the chain is the body's child
   only when the root element holds one body, no other child but the head, and the alert
   is not in the head. When it cannot tell, and a modal is open, the alert gets an
   `unverified` draft whose reason names the open modal, never a `fail`. An alert whose
   own container is hidden, below the body's child, still fails with or without a modal.
   Its own live value does not count as a
   container. An alert that cannot be found again, for example a toast that closed on
   its timer, and an alert with more than 512 ancestors each become their own
   not-covered gap, never a pass, and the check goes on to the other alerts.
2. `pf-modal-focus-return`: open a modal, press Escape, focus returns to the exact
   trigger.
3. `pf-focus-into-dialog`: focus moves into a dialog or menu on open.
4. `pf-kebab-expanded-state`: kebab and menu toggles carry correct aria-expanded and
   aria-haspopup, and focus enters the menu. The menu probe clicks each toggle and waits
   for a new menu the way the dialog probe waits for its dialog, polling for up to 2.5
   seconds, so a menu that mounts a moment after the click is checked. When the toggle
   declares `aria-haspopup="menu"`, or `"true"`, its legacy synonym, and no menu
   appears, the probe emits one `unverified` draft, because it could not check where
   focus goes. A toggle that promises no menu and opens none is not reported. A menu
   counts as opened when it is new after the click, or when it was in the page but out of
   the accessibility tree before the click and is in it after, as a menu toggled with the
   `hidden` attribute is. This costs one accessibility read per menu in the page before
   each click, and one per such hidden menu on each poll while the probe waits. A toggle
   whose `aria-expanded` is `true` before the click is skipped when a menu is open on the
   page, or when the element its `aria-controls` names is in the accessibility tree,
   because the click would close that menu. With no menu open, the toggle reports a state
   that is not true, so the probe emits one `unverified` draft that says so, and does not
   click it.
5. `pf-icon-button-name`: icon-only buttons, kebab toggles, and pagination arrows have
   an accessible name.
6. `pf-table-header-assoc`: table header association is present, and empty/loading
   states are announced.
7. `pf-row-action-name-unique`: row action buttons do not all share one accessible name.
8. `pf-toolbar-labeled-when-repeated`: a repeated toolbar is labeled so instances are
   distinguishable.

Each rule fires on the broken fixture, stays silent on the clean fixture, names the
exact control, gives a concrete fix, and carries a one-line "why a screen-reader user
is affected."

Fixture behavior alone is not enough. The fixture is written to satisfy the selectors,
so it cannot catch a selector that matches nothing on a real page. `selectors.ts` is
therefore also checked against markup rendered by PatternFly itself, held in
`fixtures/pf6/rendered-markup.html` and regenerated by `scripts/render-pf6-markup.mjs`.

`pf-modal-focus-return` and `pf-focus-into-dialog` carry a stated limit. PatternFly 6
puts no marker on a control that opens a modal: the modal comes from component state
and the trigger is an ordinary button. These rules therefore reach a modal only when
its trigger declares `aria-haspopup="dialog"`, or names the modal with `aria-controls`
and reports its state with `aria-expanded`. A modal opened by a bare button is not
checked. The probe will not click arbitrary buttons on a live screen to go looking for
one, because that would submit forms and delete records.

Cut line (dropped first if time runs short): 8, then 7 and 6. Protect 1-5.

**Marker.** The pack runs only on a page whose top document has PatternFly markup in it: an
element with a class token that starts with `pf-v6-`, `pf-v5-`, `pf-c-`, `pf-m-`, `pf-l-`,
or `pf-u-`, or a `data-ouia-component-type` that starts with `PF` (`SEL.pfMarker`). The
`pf-l-` and `pf-u-` prefixes let a PatternFly 4 page that carries only layout or utility
classes count. A class token counts only at the start of the attribute or after a space, so
`xpf-c-card` is not a match. Several selectors have generic ARIA arms, and the dialog probe
clicks disclosure controls, so without the marker the pack would report PatternFly rules
against markup another design system made. The marker is read with `queryAll`, the same read
the rules use, and it is read before any probe clicks; a read that throws reaches the
provider runner, which discloses it as a gap. When the top document has no marker the pack
returns no drafts, and reports each of its eight rules in `ProviderOutput.applicability`
with outcome `inapplicable` and `elementCount` 0, the way axe reports a rule that matched
nothing. If `Page.countEverywhere` then finds marker elements inside frames or open shadow
roots, which the rules do not read, the pack also returns one note in `ProviderOutput.notes`,
`provider:pf-rulepack/out-of-document`, that gives their count and says the PatternFly rules
did not check them. A note is disclosure only. It is not a coverage gap, the gate never reads
it, and it never moves the verdict or blocks the screen, so the pack returns no gap here. axe
and the keyboard walk still read those frames and open shadow roots. `countEverywhere` adds 0
for a frame it cannot read, so it only ever adds this note and never decides that the pack
applies. When the top document has the marker and more PatternFly markup sits elsewhere,
there is no note and no gap, and the markup elsewhere is not checked, as before. `PF_RULES` in
`rulepack/index.ts` lists the rule ids, and a unit test keeps it equal to the ids the checks
and probes write. On a page where the pack applies it reports no applicability, as before.
The pack stays off on the docs profile and reports nothing there.

### 7.2.1 RHDS rulepack

The provider id is `rhds-rulepack` (layer `rhds`, capability `live`). It checks that Red
Hat Design System (RHDS) elements are put together the way the RHDS element documentation
says. It only reads the page: no clicks and no key presses, so it does not set
`mutatesPageState`. It runs on the app and docs profiles, because RHDS is used on content
sites. It is registered in the core stack after the PatternFly pack.

Each rule quotes its source sentence word for word in `rhds/sources.ts`, from
`custom-elements.json` in `@rhds/elements` 5.0.0, which is pinned exactly as a
devDependency. A rule checks nothing its quote does not say. `test/providers/rhds/sources.test.ts`
checks every quote against that file and checks that the installed version is the pinned one.
Each draft's `why` opens with the quoted sentence, and its `fix` names the attribute or the
missing child. No page text goes into a draft: labels, ids, and `href` values decide a rule
and stay out of it.

| Rule | Element | Fails when | Evidence |
| --- | --- | --- | --- |
| `rhds-button-accessible-label` | `rh-button` | no `accessible-label`, no default-slot text a screen reader can reach, and the tree name of the inner button is empty | tree |
| `rhds-cta-link` | `rh-cta` | no `href` or an empty one, and its first child in the default slot is not an `a` or a `button` | markup |
| `rhds-tabs-paired` | `rh-tabs` | the count of `rh-tab` children in the tab slot differs from the count of `rh-tab-panel` children in the default slot | markup |
| `rhds-dialog-name` | `rh-dialog` | no `accessible-label`, no `h1` to `h6` heading with text in the header or default slot, no trigger with text, and the tree name of the inner dialog is empty | tree |
| `rhds-switch-label` | `rh-switch` | no `accessible-label`, no `label[for]` that names its id, and the tree name of the host is empty | tree |
| `rhds-accordion-header-parent` | `rh-accordion-header` | its parent is not `rh-accordion` | markup |
| `rhds-skip-link-target` | `rh-skip-link` | no `href` (or an empty one) and no slotted `a`, or an `href` fragment that names no element by id (or an anchor by name) in the document, as written or percent-decoded | markup |

Default slot means a child with no `slot` attribute or with `slot=""`, as the DOM assigns
it. The component takes any unslotted heading as its name, so an `h1` counts. An empty
heading names nothing, so it does not count as a name source, and the rule asks the tree.
Default-slot text is only the text a screen reader can reach: text under `aria-hidden`,
`inert`, `hidden`, a closed `dialog`, `display: none`, or `visibility: hidden` is left out,
so an "x" under `aria-hidden` does not stand in for a name. Text hidden only on screen, such
as a screen-reader-only class, still counts. A markup source that is missing sends the rule to
the tree, so leaving hidden text out can only lead to more tree checks, never to a fail the
tree does not confirm.

All drafts are `deterministic`. The markup rules fail outright. The naming rules trust the
accessibility tree: markup decides whether a name source exists, and a draft fails only when
there is none and the tree reports an empty name for the inner control. When the element is
not upgraded (its definition did not load, so it is not `:defined`), the draft is
`unverified`, never `fail`. When the control has no node in the tree, for example a closed
dialog, the draft is `unverified` too. The inner control is read with
`Page.axInShadowRoot`, which finds the element inside the host's open shadow root in an
isolated world and reads its node from the accessibility tree. Markup facts come from
`Page.hostMarkup`, also read in an isolated world, so page script cannot change them.

Each check runs inside its own try/catch, as in the PatternFly pack. A check that throws
becomes a `not-covered` gap named `provider:rhds-rulepack/<rule>`, and the other checks
still run.

**Marker.** The pack runs only on a page whose top document holds an element the pinned
release defines, read with `queryAll`, the same read the rules use. CSS has no selector for a
tag name prefix, so the marker lists every tag in the pinned `custom-elements.json` (all of
them start with `rh-`), and the sources test keeps the list equal to the manifest. A tag that
a later release adds is not in the list, and no rule checks it either. When the top document
has no marker the pack returns no drafts, and reports each of its seven rules as
`inapplicable` with `elementCount` 0, on both profiles. If `Page.countEverywhere` then finds
RHDS elements inside frames or open shadow roots, the pack also returns one note,
`provider:rhds-rulepack/out-of-document`, that gives their count and says the RHDS rules did
not check them. So an application shell that keeps every RHDS element in a shadow root says
which rules did not read it. The note is disclosure only. It is not a coverage gap, the gate
never reads it, and it never moves the verdict or blocks the screen. axe and the keyboard walk
still read those frames and open shadow roots, so the screen is checked by them as on any
other page. As in the PatternFly pack, `countEverywhere` only ever adds this note. On a page
where the pack applies it reports no applicability.

Stated limits. The rules read the top document only, like the PatternFly rules. When the top
document has an RHDS element, more RHDS elements inside open shadow roots or frames are not
checked and raise no gap and no note. RHDS components hold other RHDS elements in their own shadow roots,
so a gap there would fire on every RHDS page. The structure rules read authored markup, so an element that moves its children
after load is read as it is at scan time. `rhds-dialog-name` cannot confirm a name on a
closed dialog with no name source in its markup, so that case stays `unverified`.

The applicability entries a pack reports when it does not apply flow downstream like axe's
inapplicable entries. The receipt counts each such rule as abstained for the screen
(`summarizeApplicability`), the Result document carries them per screen, and an unseen
screen drops them with its drafts. The gate, the floor, and the baseline do not read
applicability.

### 7.3 Keyboard walk

Tab through the page and record/assert focus: the focused element's accessible name
and role at each step and after each interaction, read from the accessibility tree over
CDP. Bounded with a Tab cap around 200, cycle detection, a wall-clock ceiling, and
per-node partial tree reads.

Runs a small set of data-step kinds passed as data: `tab`, `press-escape`, `activate`,
and `assert-announced(region, contains)`.

Marks any focus it cannot confirm as `unverified` rather than passing. Does not hang
on a focus trap.

**How the walk ends.** The walk starts on the body. Only focus on the body can complete it: a
browser moves focus there after the last control on the page. A script that blurs a control
when it gets focus, or a keydown handler that stops Tab and drops focus, also leaves focus on
the body, in the middle of the page. So the walk confirms the end with one more Tab. In
Chromium, Tab after the last control moves focus to the body and the next Tab goes back to the
first control, on a page with three controls and on a page with one; on a page with no control,
every Tab leaves focus on the body (`test/providers/keyboard-walk.real.integration.test.ts`
records this). The walk is complete only when that extra Tab lands on a stop it already walked.
Any walked stop counts, not only the first, and a stop counts when it is the same element or has
the same path. The element is matched by the browser's own node id, read over CDP
(`Page.activeElementKey`), which does not change while the element stays in the document. So a
first control that goes away during the walk, such as a timed banner whose removal moves every
control after it to a new path, still wraps to a known stop, and so does a list that re-renders
and puts a new item at the path of the first stop. When the browser gives a node id for both
elements, a path match alone counts only for the first stop walked, so another element that took
a later stop's path does not confirm the end. After the extra Tab, the walk discards what that
Tab announced and puts focus back on the body, so a flow or voice contract that runs next starts
where it did before the end was confirmed. A walk that reached no stop is complete only when
the extra Tab leaves focus on the body, and that page is then left to the blank-page detector
below, which runs in the CLI only. Anything else ends with `keyboard-walk-truncated` as `unverified`, whose `why` says one
more Tab did not go back to a control the walk had reached. A page with one control or a skip
link wraps as any other page does. Tab that brings focus back to
a stop already reached, without passing through the body, is a cycle, and a cycle means Tab
never reached the rest of the page. So a cycle never ends the walk as complete. It ends with
`keyboard-walk-truncated` as `unverified`, and the cycle is the stops from the first visit of
the repeated stop to the last stop before the repeat. Only those stops are judged, never the
stops walked before the cycle began. A cycle that one open modal dialog holds in full is read as
expected, because a modal dialog may keep focus inside itself. The gap then says focus stayed
inside an open modal dialog and the rest of the page was not walked, and nothing else is
reported. The gap makes no claim that the dialog is right to keep focus: its role and
`aria-modal` come from the page. Every other cycle is a keyboard trap (WCAG 2.1.2, No Keyboard
Trap), and the walk also emits one deterministic `keyboard-walk-trap` draft: severity
`critical`, confidence `fail`, layer `walk`, the path of the first stop of the cycle as its
element path, and `evidence.extra.cycle`, the path of each stop of the cycle in Tab order. The
draft carries no page text: no name, no role, no label. A control that keeps focus on every
Tab is a trap of one stop.

An open modal dialog is read at each stop, by `Page.activeModalDialogs`, from the element
that has focus up the flat tree: a slotted element climbs through its slot, a shadow root
climbs to its host, and a same-origin frame climbs to its frame element. A `dialog` element
counts only in the browser's own `:modal` state, which only `showModal()` gives it, so a
dialog opened with `show()` or the `open` attribute is not modal. An element whose first
recognized role is `dialog` or `alertdialog` with `aria-modal` true counts while it is
connected, rendered, not hidden by visibility, and not under `aria-hidden`, `inert`, `hidden`,
or a closed `dialog`. That test is the same one the announcement capture uses, so the walk and
the capture read a modal the same way. A cycle counts as inside one only when the same dialog holds every stop of it, so
a cycle that passes through two dialogs, or leaves the dialog, is a trap. A dialog opened with
`showModal()` and no script that keeps focus in it lets Tab leave the document after its last
control, so focus reaches the body and the walk ends complete. The content behind such a
dialog is inert: out of reach of the keyboard and left out of the accessibility tree.

**Shadow roots and frames.** `document.activeElement` stops at the host of a shadow root
and at a frame, so every control inside one would get the host's or the frame's path. The
walk would read the second control as a return to the first, end as if the focus order were
done, and never reach the controls after it. The focus read therefore follows focus into
every open shadow root and every same-origin frame, in an isolated world, to the element
that really has focus. Its accessible name and role are read from that element, and its
path joins the path of each tree in turn: ` >> ` before the path inside a shadow root, and
` >> internal:control=enter-frame >> ` before the path inside a frame. These joined paths
are identity strings, not selectors or locators: no code looks an element up by them, and a
locator built from one can match more than one element, because Playwright's CSS engine also
searches open shadow roots. An element outside every shadow root and frame
keeps the path it had before, so its identity key does not change. The walk ends as
complete only when focus reaches the body. The read enters `iframe` and
`frame` elements only. Any other element that holds a frame, such as an `object` or `embed`
element that shows a document, or a `fencedframe`, is found through the browser's own DOM read
over CDP (the browser gives a frame owner a frame id or a content document), and focus on it
counts as a frame the read cannot see into. When focus moves into a closed shadow root, into
a frame from another origin, into such a frame owner, or under more than 1024 shadow roots
and frames, the walk cannot tell one control there from another. It stops and emits
`keyboard-walk-truncated` as `unverified`, which names the cause, so the screen is not
covered instead of passing. A closed shadow root that does not hold focus, such as one
inside a focusable host, is walked past as usual.

**A blank page.** Each stop of the transcript the check runner collects records whether the body
had focus there (`onBody`), read from the page in an isolated world. A screen where every stop
has focus on the body is unseen: a page that never rendered, one behind a login, and one that
threw on mount all look like this, so its findings are dropped and it gets a `not-covered` gap
(`coverage/unseen.ts`). The detector reads that fact, not the path. A body with an id has that
id as its path, so `<body id="app">` never read as the body when the detector read the tail of
the path, and a screen that crashed on mount read as seen. An empty transcript is no evidence
either way, so it is not unseen. The detector runs in the CLI only. `checkPage` collects no
transcript, so it has no blank-page detector: a blank or crashed page handed to `checkPage` reads
as checked unless its screen declares a `reachedWhen` readiness signal that the page fails.

Known limits of what the scan sees. A page with no tabbable control has a walk that stays on the
body, so the CLI reads it as unseen. A readiness signal that holds does not change that, because
the two detectors are independent (`coverage/unseen.ts`). In `checkPage` the same page reads as
checked. The menu and dialog probes each wait up to 2.5 seconds for the menu or dialog to open,
and that wait is a wall-clock limit: a menu or dialog that opens later is read as one that did
not open, which is an `unverified` draft when the toggle or trigger promised it and nothing
otherwise. The live-region
capture still records text that is out of the accessibility tree in three cases it does not
read: text under `content-visibility: hidden`, text inside a closed `details` element, and text
under an element hidden through `ElementInternals`.

The other checks that read focus treat an unreadable focus the same way. Each transcript
stop records why its focused element could not be read. At such a stop, the interaction
contract tier emits `voicing/focus-unreadable` as `unverified` instead of
`voicing/missing-name` or `voicing/missing-role`, and the word-level tier keeps a missing-words
draft `unverified` even for a promoted obligation class. A flow requirement whose text was not
heard in an announcement emits its draft as `unverified`, with the cause, instead of `fail`,
because the text may be the name of the control it could not read. The live announcement
check still runs at such a stop, since what the capture heard does not depend on the focus
read.

### 7.4 Declarative interaction probes

Multi-step interactions expressed as data (JSON steps a generic runner executes). A
step that cannot establish its fact emits `unverified`. Adding a new interaction check
needs no engine change, just data.

### 7.5 Voicing lane (voice requirements)

The voicing lane lives under `src/voicing/` and is exported from the library
(`runStructuralTier`, `runVoicingTier`, `makeVirtualSrProvider`, `normalizeToken`,
`obligationSatisfied`). It runs an interaction contract, a list of steps and what a screen
reader user must hear after each one, on a live page. A team writes a contract as a `voice`
requirement in the requirements folder (section 13). Each voice requirement becomes one
provider named `intake:<id>`, built where the flow providers are built, so the CLI scan and
`checkPage` both run it. Like a flow provider it is flagged as changing the page, because it
clicks and presses keys, so it runs after every provider that reads the page as loaded,
the PatternFly rulepack included.

What it proves. The runner records one stop for each step, after the step and the settle wait.
At the stop named by an obligation's `afterStep`, the structural tier checks that the focused
control has an accessible name, that it has the `focusedRole` when one is given, and that a
live region received some text when `mustAnnounce` is true. The voicing tier checks that the
words of that stop, the focused control's name, role, and states and the live text, hold every
`requiredTokens` word, compared without case or punctuation in any script. Two checks prove
less than their names suggest. Because there is always one stop per step, the "focus did not
reach the window" draft never fires on a scan; it fires only for a hand-built transcript. And
`maxTabPath` is compared with the number of stops, which is the number of steps the contract
lists, so it checks the length of the contract, not how many Tab presses a user would need.
None of this proves what a real screen reader says; the transcript comes from the
accessibility tree and the live-region capture (section 26).

Preview by default. Both tiers emit `preview` drafts, with confidence `unverified`, unless the
obligation's `class` is listed in `promotedObligations` in the trusted config. Preview never
moves a verdict: the gate ignores it, and `checkPage` lists it as `advisory` (section 11.6). A draft about
the whole contract, such as no stops at all or an over-long tab path, is deterministic only
when every obligation class in the contract is promoted. No class has met the promotion bar,
so nothing from this lane blocks a run until a person promotes a class. Under a trusted ref,
`promotedObligations` is read from the trusted config like every other field, so a pull
request cannot promote a class for its own run, and when the trusted config is missing or
unparseable no class is promoted.

Rule ids. The tiers emit `voicing/` rules, such as `voicing/missing-name`. A provider built
from a voice requirement replaces `voicing/` with the requirement, as in
`intake:delete-row-announces/missing-name`. A finding's identity is its screen, its rule, and
its element, so without the requirement in the rule two contracts with a miss on the same
control would share one identity, and a waiver or floor entry written for one would cover the
other.

Settling. After each contract step the runner waits for the page to settle, and only then
reads focus and drains the live record. Settled means three things at once: five equal element
counts in a row, 500 ms apart, so at least 2 seconds; no network request in flight for 500 ms;
and no text recorded by the live-region capture for 500 ms, read without draining it. The third
signal catches a live region whose text changes late with no element added and no request sent.
The wait has its own cap of 6 seconds, far below the page-load budget; a page that settles
returns as soon as it does, so only a page that never settles pays the whole cap. Before the
first step the runner drops what earlier checks left in the record. A window where the page
was still changing at the cap, or whose drain cannot say what a screen reader heard (section
11.6), decides nothing: each obligation in it becomes one `window-undecided` draft,
`unverified`, that names the contract, the step, and the cause, never a miss and never a pass.
It is preview unless the obligation class is promoted; promoted, it is a deterministic
`unverified` draft, so the run reads `not_covered`. The draft carries no wait time, so the
result does not depend on how long the wait took. The keyboard walk does not wait this way.

Static-only runs. A static-only run grants no live capability, so each voice provider becomes a
`capability-denied` gap with ref `provider:intake:<id>` and reason
`provider intake:<id> denied capability: live`. The screen is then not cleanly scanned: no
voicing finding, and no clean pass for that screen.

#### 7.5.1 Silent change rule (no contract needed)

The silent change rule is an additional check in the voicing lane. It flags an action step that
changes the page, is not announced, and does not move focus to a named control. Nobody has to
write down what the step should have said. It lives in `src/voicing/silent-change.ts` and
`src/voicing/tree-change.ts`, and its rule id is `voicing/silent-change`.

Where it runs. Inside the two loops that already drive steps: the flow provider's own step loop
and the contract step runner of each voice requirement. It reads around each step those loops
drive and never drives a step itself, so it cannot delete a second row. It adds no step, needs
only the `live` capability, and makes no network call. It runs whenever a flow requirement or a
voice requirement runs on its screen. With neither, there are no driven steps, nothing runs, and
no provider is added. Its drafts come back with the drafts of the provider whose loop it watched,
under its own rule id, never the requirement's.

What an action step is. A step of kind `activate` (Enter on the focused control) or `click`. A
Tab step is not one: Tab moves focus, and the focused control's name and role are the speech for
it. A `press` step and a key such as Escape or an arrow key are not judged, and `type` steps
are out, because a character counter would be a finding on every keystroke.

What it reads, per action step:

1. Did the page change in a way assistive technology can perceive. Two reads of the whole
   accessibility tree of the main frame, one before the step and one after its settle window
   (the wait in section 7.5), through `Page.fullAxTree()` over `Accessibility.getFullAXTree`.
   The browser computes that tree, and no page script world takes part. A change is a node
   added or removed, or a name or a checked, expanded, pressed, selected, invalid, or sort
   state that changed, outside the control's own change. Nodes are matched by DOM backend node
   id. The browser does not expose `aria-sort` as a tree property, so the sort state of each
   column and row header is read from its attribute through the browser's DOM read, inside the
   same budget. The control's own change is its own states, the states of its ancestors, and
   every node its `aria-controls` names, with everything under those nodes, when its own state
   changed in the same step. A tab that becomes selected also deselects the tab it replaces, a
   node with the same parent and role that is still in the tree after the step, so that tab's
   state change, and the nodes its `aria-controls` names, are the control's own change too. A tab
   that was removed was not deselected, and the panel it controlled is not exempt. So a disclosure that shows its
   panel, a tab that shows its panel, and a sort header that re-orders its rows are the control
   speaking for itself, and the voicing tier already checks that speech. Values never count and
   are never read: a field's value, and the text inside an editable field, are left out of the
   read.
2. Was anything heard. The step's own drain, with the same hidden and modal rules as every
   announcement check (section 11.6), so a region in a dialog the step closed, or outside an
   open modal, is not heard. Each record carries the live region that wrote it and whether the
   change was only a removal. A record that holds only a removal, which is how a toast that
   dismisses itself shows up, is never credited as heard. A live region that also wrote before
   the first step makes speech from that region inside a step's window a gap, because a ticker
   or a polling counter speaks whether or not the action did anything.
3. Did focus move to a named control. Identity is the DOM backend node id
   (`Page.focusedNodeId()`). Moved means the focused node after the window is a different node
   than before, has a non-empty accessible name, and has a role other than generic or none. Focus
   that lands on the control that received the action is never a move: a mouse click focuses the
   clicked button before the click fires. For a `click` step, the control is the element its
   selector names, resolved by `Page.controlNodeId()` in an isolated world with a query that looks
   in the document and in every open shadow root, as the click does. A name change on the acted
   control while it keeps focus ("Save" becomes "Saved") counts as the control speaking for
   itself, because readers usually speak a name change on the focused element.

A step that changed the page, was not heard, and moved focus nowhere named is a finding: rule
`voicing/silent-change`, evidence class `preview`, severity `serious`, confidence `fail`. Its
element path is the control that received the action: the step's selector for a click, the
focused element's path for an activate. It names no element, because the control may be the
row that was deleted. Its evidence is the step as its kind and selector, the counts of nodes
added, removed, and changed by role, and the names of added nodes only, each once, sorted,
capped at three. It never holds a value or a removed node's name, so a deleted row's data does
not reach a pull request comment. Every string goes through the scrubber in the provider. The fix
text reads: announce the outcome in a live region that is shown and inside the open modal, or
move focus to a control whose name states it.

The rule stays quiet only where it would repeat the flow requirement's own draft for the same
step. When the flow fails because its expected announcement was not heard, the rule emits nothing
for the last step, which is the step the flow judged: the flow's draft already says the step was
silent, and the gate keys identity by rule, so a second draft would be a second finding for one
accessibility barrier. When the flow is a gap because a drain could not say what was heard, the
rule drops its own `announcements undecidable` gap on the step whose drain the flow's gap names,
the first undecidable one, and on no other step. When a step's drain is undecidable, the rule
names that reason before any other focus reason, so the flow's gap covers the step. A finding or a
gap on any other step is always emitted.

What is a gap, never a finding and never a pass. Each is an `unverified` preview draft on the
step, with the reason in `evidence.extra.reason`:

- `navigated`: the main frame loaded a new document, or the URL path changed, during the step;
- `not settled`: the page was still changing at the end of the settle window;
- `still busy`: a node is still `aria-busy` at the end of the window;
- `tree over budget`: a tree read took more than 500 ms or returned more than 5000 nodes;
- `unreadable control`: the page changed and the click selector names no one element in the
  document or one open shadow root, because it matches nothing, is not CSS the browser parses,
  or matches in both the document and a shadow root, where the click's own order cannot be read.
  A selector with a combinator (a space, `>`, `+`, or `~`) on a page with any open shadow root is
  this gap too: the click engine can match it across a shadow boundary, and the browser's own
  query cannot, so the element found may not be the one the click takes;
- `focus unreadable`: the focused element cannot be read (section 7.3), or focus after the step
  is on a node that is not the acted control and is not in the tree read after the step, such as
  a control inside a same-origin child frame, which the tree read does not cover;
- `replaced focus`: focus ended on a new node with the same name as the acted control or the
  node that had focus before, so the read cannot tell a re-render from a move;
- `announcements undecidable`: the drain cannot say which announcements a screen reader spoke;
- `background announcements`: the only speech in the window came from a region that also wrote
  before the first step;
- `step not run`: the flow driver cannot run the step as written, such as an unknown kind, a
  click with no selector, a press with no key, or a step with a field its kind does not use. The
  flow then runs none of its steps and is a `not-covered` gap (see "Flow steps the driver cannot
  run" below), and the rule's gap for each such step comes with it. The driver used to skip such a
  step without a word;
- `step threw`: the step failed, which leaves it and the steps after it unjudged. The provider
  still fails the way it always did, as a `not-covered` gap with the same reason, and the rule's
  drafts for the steps that ran come with it. The rule's draft keeps only the first line of the
  error, through the scrubber, because the browser's call log can quote the element's markup;
- `read failed`: a read the rule needs failed. The draft keeps only the first line of the error,
  through the same helper as `step threw` and then the scrubber, because a browser error's later
  lines can quote the element's markup.

Only a step that was read in full, settled, and not busy is dropped when it changed nothing. A
step that changed nothing but met `read failed`, `navigated`, `not settled`, `tree over budget`,
or `still busy` is still that gap, because those are checked before the trees are compared.

Flow verdicts now read each step at its own time. The flow loop waits for the page to settle
after each `click` or `activate` step, and drains after every step. Its verdict reads the union
of the drains taken after its steps, in step order. The hidden and modal
rules (section 11.6) run when each drain is taken, so each step's text is judged against the page
as it was after that step. Before, the flow drained once, right after its last step, with no
wait, and judged every step's text against the page as it was then. This can change a flow
verdict, in both directions. A team can see these differences:

- text written inside a dialog that a later step closes is now heard, where it was dropped;
- text written outside an open modal that a later step closes is now dropped, where it was heard;
- an announcement that lands shortly after the click, inside the settle wait, is now heard, where
  it was missed;
- focus that rests on a control named with the expected text, and that a re-render takes away
  during the wait, is now read after the wait, so the flow can fail where it passed;
- a step that loads a new document, or whose target is gone after the settle wait (an Undo
  toast, or a menu that closes on a timer), makes the flow a `not-covered` gap.

The wait costs at least 2 seconds per `click` or `activate` step, up to the 6 second cap, in every
flow, whether or not it expects an announcement. Real-Chromium tests hold the two dialog cases and
the late announcement at the flow verdict.

Speech recorded before the flow's first step never counts. An earlier check can leave speech in
flight, such as a status message that lands after its click. So before its first step the flow
waits for the page to go quiet, with the same settle wait a `click` step uses, and then takes a
drain. The capture runs for the life of the page, so that drain holds every announcement since the
last drain on the page, such as one an earlier check caused, and any that landed during the wait.
The flow's verdict never passes on that drain and never fails on it: the flow is judged only on
what was announced after its first step ran. When the expected text is in that drain and the
flow's own steps did not announce it, the flow is an `unverified` gap. The text was announced
before the flow's first step, and an earlier check may have changed the page (it may have saved
once already), so usabl cannot tell whether these steps announce it. When that drain does not
hold the text either, the flow fails as before, or is a gap when the focused control cannot be
read. The undecidable reason of that drain decides nothing either, since its texts are not read.
The silent change rule still takes that drain as its background speech. The voice contract step
runner already drained and discarded the same way.

In a flow that expects an announcement, a page that does not go quiet within the wait's cap, or a
wait that fails, makes the flow a `not-covered` gap that says so, and the flow runs none of its
steps. A failure of the drain itself does the same, because the speech it should have cleared
could then land in the first step's drain. A flow that expects no announcement judges no speech,
so it runs on such a page as before. The wait costs at least 2 seconds per flow, up to the 6
second cap. Real-Chromium tests hold this. In one, an earlier click announces "Saved" and waits,
the flow only presses Tab, and the flow is a gap. In the other, an earlier click writes "Saved"
300 ms later and does not wait, and the text lands in the drain the flow does not count.

One limit stays. Speech an earlier check started that lands later than that wait is still read as
the flow's own. A status message on a timer longer than the quiet window arrives in a step's drain,
and the flow cannot tell it from speech its steps caused.

Focus that was already there is not evidence. Before its first step, a flow that expects an
announcement records the focused node, by DOM backend node id (`Page.focusedNodeId()`), and its
accessible name. After its last step, the focused control's name counts toward the verdict only
when the focused node or its name differs from what was recorded. When the expected text matches
the focused control's name but neither changed, and no step's announcement held the text, the
flow is an `unverified` gap that says focus was already on that control before the flow ran. When
focus could not be read before the flow, whether it moved is unknown, and the same case is a gap
that says so. A control drawn again with the same name is a new node, so it still counts as a
change. A flow whose steps leave focus where it started, such as one that opens a dialog and
closes it with Escape, is now a gap in this case where it passed, because an earlier check may
have put focus there. A drain that cannot say what was heard makes the flow a gap on that reason
unless the steps moved focus to a control with the expected name.

Flow steps the driver cannot run. Before it runs any step, the flow driver checks every step. A
`click` with no selector, a `press` with no key (a missing, empty, or blank value counts as no
value), and a step of any kind other than `tab`, `activate`, `press`, or `click` cannot be run. An
`activate` step presses Enter on the focused control and needs nothing more. A step that carries a
field its kind does not use cannot be run as written either, because the driver would ignore the
field and run something other than what was written. Examples are a selector on `activate`,
`press`, or `tab`, a key on `click`, `times` on `tab`, `shift` on `press`, and `expectedAnnouncement`
written inside a step, where the flow would then check nothing. A comment field such as `note` is
an unused field too. `tab` and `activate` take only `do`, `press` takes `do` and `key`, and `click`
takes `do` and `selector`. That list is one table beside the driver (`FLOW_STEP_FIELDS` in
`src/intake/map-to-providers.ts`), and a test runs the driver on each kind and checks that it reads
exactly those fields. When a step cannot be run as written, the flow runs none of its steps, takes
no drain, and is a `not-covered` gap. The gap's reason names each such step by its number, counted
from 0, its kind, what it is missing, and each unused field with the fields its kind takes. The
flow never runs such a step as nothing and never passes. The requirement loader accepts these
steps in a flow: a flow step needs only a non-empty `do` to load, and any other field loads with
it. Only voice requirements refuse them when the file loads. So a flow file with such a step loads,
and the driver then reports the flow as not covered. The gap of a flow provider that throws, as
for any `ProviderRunFailed`, keeps only the first line of the error, through the same helper the
silent change rule's gaps use, because a browser error's later lines can quote the element's
markup.

Cost. Two tree reads per action step. Each read is bounded at 500 ms and 5000 nodes, and a read
over either is the gap above. The time bound is a timer: each browser call in the read races it,
so a call that is slow or never returns ends the read at 500 ms. Measured on `usabl-app` (commit 6118ea7, served by its own Vite dev
server): `usabl-app` has no delete or save flow, so five click actions across its four screens
were measured instead. Every read stayed inside the budget, at 26 to 250 ms, and the browser
returned 179 to 300 nodes per read (132 to 207 kept after inline text boxes and field content
are left out).

Known limits. The capture covers the main frame and the light tree. The full tree read covers
the main frame and, because the browser builds it from the flat tree, open shadow roots too; a
real-Chromium fixture confirms this. Child frames are read by neither. A node that holds an
editable field, such as a row or a button with a text box inside, can take its name from its
contents, and those contents include the field's value. When the browser says such a node's name
comes from its contents, or does not say where it comes from, the read leaves that name out: it is
never shown in evidence, a change of it never counts as a page change, and focus that moves to
that node does not count as a move to a named control. An author-given name, such as
`aria-label`, is kept. A name built through `aria-labelledby` from a field can still hold that
field's value, and the rule does not take a name apart. Background announcements are found only from
the drain taken before the first step: a ticker that first writes inside a step's window, or
between two steps, reads as speech that step caused. A live region that is drawn again, as a new
element, counts as a new region, so a ticker that draws its region again is not known as
background. The settle element count still runs in the page's own world, so
a page that patches `getElementsByTagName` can end the window early. Moving that count to an
isolated world is planned, with this rule's patched-page test.

What it never does. It never minds the words: "Saved" after Delete passes this rule and fails a
contract that requires "deleted". It never blocks: the class is preview, so the gate ignores it
and `checkPage` lists it as advisory, until calibration (section 26) measures it in both
directions. It never reads page text as instructions.

### 7.6 Documentation profile (docs-content)

The same providers run over product documentation pages when a scan target carries
`profile: 'docs'` (`ProfileName = 'app' | 'docs'`; absent means `app`, and each
provider reads `ctx.profile ?? 'app'`). The profile is threaded per scan target, so a
single run scans app screens and doc pages together and the gate returns one verdict, or none,
across both. There is no separate docs engine and no separate command.

Per-provider behavior on a docs page:

- **axe-core** runs scoped to the WCAG 2.2 AA tag set (`wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa`) instead of its full rule set, matching the Red Hat docs bar.
- **docs rulepack** (`id: docs-rulepack`, layer `docs-content`) contributes one static
  check, `docs-heading-order`: a rendered heading that jumps more than one level down
  is a `deterministic` fail, read from the accessibility tree. axe-core's own
  heading-order rule is tagged best-practice, not WCAG, so it never fires under the docs
  tag set; this rulepack fills that gap with doc-worded copy. It returns `Draft[]` and
  never mints a verdict.
- **PatternFly rulepack** is a no-op (`return []`): product docs are not a PatternFly UI.
- **RHDS rulepack** runs unchanged, because RHDS is used on content sites. It applies only
  where an RHDS element is on the page (section 7.2.1).
- **keyboard walk** runs unchanged.

### 7.7 Optional commercial engines (Deque axe DevTools, Evinced)

Two optional providers run a vendor's Playwright SDK beside usabl's own checks. They are off unless
the trusted `usabl.config.json` turns them on, and the vendor packages are never dependencies of
usabl: the operator holds the license and installs the package from the vendor's registry.

**Status.** Tested against the vendor's documented result format. Not yet run on a licensed SDK.
Every finding from either engine is `preview` evidence: it is shown on every surface and never moves
the verdict. No config key can promote one. A live run on a licensed SDK has to show which rule
types repeat before any of them may gate. `usabl doctor` prints
the same status line in its engines section whether or not an engine is on.

| Engine | Package | Provider id | Layer | Rule ids | Evidence class | Capabilities |
|---|---|---|---|---|---|---|
| Deque axe DevTools for Web | `@axe-devtools/playwright` | `deque` | `deque` | `deque:<rule id>` | `preview` | `live`, plus `network` when `trackUsage` is true |
| Evinced Automation for Web | `@evinced/js-playwright-sdk` | `evinced` | `evinced` | `evinced:<issue type id>` | `preview` | `live`, `secrets`, plus `network` in online mode |

```json
{
  "engines": {
    "deque": { "enabled": true, "rulesetId": "wcag2.2", "trackUsage": false },
    "evinced": { "enabled": true, "mode": "offline" }
  }
}
```

**Config.** `engines.deque` accepts `enabled`, `rulesetId` (passed to Deque's builder as is; absent
means Deque's default), and `trackUsage` (absent means false). `engines.evinced` accepts `enabled`
and `mode` (`offline`, the default, reads `EVINCED_SERVICE_ID` and `EVINCED_AUTH_TOKEN`; `online`
reads `EVINCED_SERVICE_ID` and `EVINCED_API_KEY` and contacts Evinced's license server). An unknown
key is refused. A `promote` key is refused with its own message, because findings stay preview.
The providers take an evidence class and a promote list as code options so the gating paths can be
tested; config cannot set either.
Engines are trusted-only, like `requirements` and `judge`: under a trusted ref they come from the
committed config, and a missing or unparseable trusted config turns them off. The Playwright helper
(`checkPage`) does not run them, because it reads the working tree's config and its page verdict
counts every failing draft.

**What each engine adds.** Deque returns standard axe-core results. The open-source axe rules in them
are dropped, because the axe provider already reports them, and Deque's own rules map through the
axe provider's mapping (`mapAxeRunResult`) under the `deque` layer and the `deque:` prefix. Finding
identity leaves the layer out, so the prefix is what keeps a Deque finding from sharing an identity,
a floor entry, or a waiver with an axe finding. Deque records applicability for its own rules.
Evinced runs with every open-source axe rule switched off inside it and with platform upload off,
and maps one draft per element that has a selector. It reports no passes, so it records no
applicability and never claims a rule ran clean.

**What becomes a gap, and what becomes a note.** While engine findings are preview, a run that could
not use the engine is a provider note on `provider:deque` or `provider:evinced`, never a gap. The
note says the engine did not run, why, and that its findings are preview so the verdict does not
change. A missing preview engine cannot hide a barrier the gate would have blocked on, so it must
not stop a screen from being cleanly scanned or a run from being verified. The note covers every
failure: the package is not installed; the package is installed but a package it needs is not
(named); the package throws while loading; a credential variable is not set (named, never its
value); the page has no Playwright page behind it; the SDK returned something that is not its
documented shape; Deque ran no rules at all; any vendor call did not finish within
`ENGINE_CALL_TIMEOUT_MS` (60 seconds), which is how a hung license server ends; `AXE_TRACK_USAGE` is
not `false` (below); or a switch outside the trusted config could change what the engine does
(below). Each provider catches its own failure and returns the note, so the provider seam never
turns it into a `provider failed` gap. An entry or element the engine returned that usabl could not
read is also a note. When Deque returns entries but every one is an open-source axe rule, one note
says Deque reported only rules axe already runs, so an empty Deque section is not mistaken for a
clean one.

The code keeps the switch for a class that gates. When the evidence class gates (Deque) or a type is
promoted (Evinced), every one of those failures and lost entries is a `not-covered` gap instead, so
the protection is in place before promotion exists.

Preview engine drafts skip the row read (section 9, Identity, row keys). The row read exists to keep a
blocking finding's identity stable across rows, and an unreadable row adds a gap. A preview draft
never blocks, so it gets no row key and no gap. A deterministic draft on the same page still gets
both.

**Switches outside the trusted config.** A switched-off SDK returns an empty result, and an empty
result reads as a clean screen, so each provider refuses to run while such a switch could be set:

- Evinced: `EV_SWITCH_ON` set to anything but `true`, or an `evConfig.json`, `evConfig.yaml`, or
  `evConfig.yml` in the working folder that is not in `guardedPaths`. The analyze options also pass
  `switchOn: true`.
- Deque: `AXE_RULESET_PATH` set, or an `axe-ruleset.json` in the working folder that is not in
  `guardedPaths`. Deque documents both for its CLI, where a ruleset file replaces the whole axe-core
  ruleset. Its Playwright reference does not say whether the SDK reads them, so usabl assumes it may.
  Its Playwright reference also names a "script-builder custom rule configuration file" that the
  builder reads when no ruleset is given, without naming the file; usabl cannot check that one.
- Deque usage tracking: Deque's usage service is on by default, and `AXE_TRACK_USAGE=false` is the
  documented way to turn it off. With `trackUsage` absent or false, usabl refuses to run Deque unless
  `AXE_TRACK_USAGE` is exactly `false`, and checks this before it loads the package, because the
  variable is the only switch that covers the package load and the builder's construction. When it
  runs, it also calls `enableTracking(false)` on the builder if the builder has one. usabl never
  writes the environment. The refusal and doctor both say to set `AXE_TRACK_USAGE=false` or to set
  `engines.deque.enabled` to false. With `trackUsage: true` the variable is not checked.

**Docs screens.** On a `docs` screen Deque runs with `withTags` set to the same WCAG 2.2 AA tag set
axe uses (section 7.6). A builder without `withTags` does not run on docs screens, with a note. Whether Deque narrows
a chosen `rulesetId` further by tags is not stated in its reference. Evinced has no tag filter and
runs its full set on docs screens.

**Finding the package.** The run imports the package with a dynamic import. Doctor and the run's
failure messages find it the way that import does: `node_modules` in the folder of usabl's own module
and every folder above it, from its real path, never `NODE_PATH` or a global folder. Doctor also
checks that every dependency and non-optional peer the vendor package declares resolves from the
vendor's folder, and names any that do not. That check starts from the vendor folder's real path,
as Node does, so a package that pnpm links in from its store finds its dependencies beside it in the
store. Doctor runs no vendor code, so a package that resolves and then throws while loading is caught
only at run time, as "failed to load".

**Receipt.** Each turned-on engine's installed version joins `scannerVersions.engines`, keyed by
engine id, or `not-installed`. A receipt minted with one set of engine versions fails
re-verification under another, and a receipt minted with no engine keeps its earlier shape
(section 10, receipt binding). The receipt's per-screen applicability counts include the Deque
rules that ran, because Deque records applicability for its own rules. Those counts never gate.

**Limits.**
- The vendor SDK runs inside the scan process with the operator's credentials and the whole
  environment. usabl does not sandbox it. See the threat model, "A vendor engine SDK in the scan
  process".
- Both SDKs run their scripts in the page's own world, unlike usabl's axe, which runs in an isolated
  world (section 7.1). Page script can change what they read and report. This is one more reason
  their findings are preview.
- A vendor call that times out cannot be cancelled. It may keep running in the page while the
  providers that change page state run after it; its late result is dropped.
- The engines run after the read-only providers and before the ones that change page state. A vendor
  script that changes the DOM would be seen by those later providers.
- Evinced's issue shape is only partly documented. Every field is read defensively. The first live run on a
  licensed SDK has to record the real shape.
- Yarn Plug'n'Play installs have no `node_modules`. The import can still work there, but doctor and
  the run's failure messages look only in `node_modules`, so doctor says the package is not
  installed.

---

## 8. Coverage and discovery

### How it works

**Which files changed.** A local run takes the paths
`git status --porcelain -z --untracked-files=all` reports. A run with `--trusted-ref` joins them
with the merge-base diff, `git diff --name-only -z <ref>...HEAD`. Every git listing usabl reads
(status, diff, `ls-tree`, and `ls-tree -r --name-only`) runs with `-z` and is split on NUL.
Without `-z`, git quotes a name that holds a byte above 0x7f, a newline, a tab, or a double quote,
so `src/pages/Über.tsx` arrived as `"src/pages/\303\234ber.tsx"`, matched no UI glob, and a CI
run read as nothing to check. Names are never trimmed, so a name that starts or ends with a space
is kept. A `**` in a glob matches any character, a newline included, so a name with a newline
matches `src/**`. A changed path that starts and ends with a double quote, the shape git prints
for a quoted name, is an `unresolved` gap that says why, never a file outside the UI globs. A real
file name of that shape is a gap too, and the reason says to rename it. A name such as `"draft".md`
does not have that shape and is read as the file it names. The same listing reads the trusted
requirement files and the guarded files at a ref, so a file there with such a name is read too.

New untracked files are listed one by one. Without `--untracked-files=all`, git status lists a new
folder as the folder alone, which matches no file glob, and a user's
`status.showUntrackedFiles=no` hides new files completely. A listing longer than usabl reads (10
MB of output) stops the run with an error that says so, never a short list read as complete.

A rename is listed by its new name only, on local runs and in CI. The old name is not listed. So
a file moved out of the UI globs, or into a test folder, is seen only through other changed files:
the files that import it, and the router file or `usabl.routes.json` when a route names it. An
import left pointing at the old path is an import usabl cannot resolve, so a file moved into a
test folder under the same name is a gap (see "Test files" below). A move that changes nothing
else, such as moving a route's entry file while the route still names the old path, is not seen.

Given a set of changed files, discover which surfaces they affect:

1. Build a route manifest from the router source (or use a configured override).
2. Build a static import graph from each route's entry file (BFS over imports).
3. Match each changed file against the import-graph closures.
4. Wide-blast fallback: files matching `wideBlastGlobs` (global CSS, app shell, build
   config) affect every extracted route. So does a dependency change of the app (see
   below), which also affects every configured surface.
5. Manual surface globs in config are an additive fallback, never a replacement.
6. Anything resolving to nothing stays in `unresolvedFiles` and forces `not_covered`.

**Dependency changes.** A pull request that bumps the UI component library touches the app's
`package.json` and the lockfile, and neither matches `uiFileGlobs`. A new version of the
library can change every screen, so such a change is wide blast, not nothing to check. A
changed file is a dependency change when it is:

- a lockfile (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `bun.lock`, or `bun.lockb`) in the repository root or in one of the app's folders. Any change
  to it counts, because a lockfile change can change the version of any installed package.
- one of the app's `package.json` files, when its dependency fields differ from the same fields
  at the trusted ref. The dependency fields are `dependencies`, `devDependencies`,
  `peerDependencies`, `optionalDependencies`, `overrides`, `resolutions`, and `pnpm.overrides`.
  Each of them can change which version of a package is installed, and counting one that does
  not can only add checks. The two versions are parsed and the fields compared as data, so key
  order and whitespace do not count. A change that leaves every field as it was, such as one
  that edits only `scripts`, `version`, `description`, other `pnpm` settings, or other metadata,
  is not a dependency change and reads as before. A file missing on one side declares no
  dependency fields, the same as a file that holds an empty object, so an added `package.json`
  with none of them does not count, and a deleted one that had some does. When either version
  does not parse, or no trusted read is given, usabl cannot compare, and the change counts.

The app's folders are, for each place the config points into (the router file, the folder of
each `uiFileGlobs` pattern, and each surface file), every folder from it up to the repository
root that holds a `package.json` in the tree or at the trusted ref. A leading `/` is read from
the repository root, and a path that leaves the repository with `..` is never read. Every folder
on the climb counts, not only the nearest: a pull request that adds `packages/admin/src/package.json`
would otherwise move the app folder off `packages/admin`, and a bump of the real manifest would
read as nothing to check. In a monorepo this includes the root `package.json` as well as the
app's own package, such as `packages/admin`. A `package.json` or lockfile of a package that is
not on the climb, such as another workspace package, does not count. A dependency change queues every discovered route and every
configured surface with provenance `wide-blast`, and each such screen carries a `reason` that
names each dependency file and why it counts. With no route and no surface, each dependency file
is an `unresolved` gap that says there was no screen to check, never nothing to check.
Surfaces are queued by screen id, never by url, on every path: a dependency change, a changed
file that matches `wideBlastGlobs` and that a surface lists in its `files`, a route-graph match,
and a manual surface match. A surface that shares its url with a discovered route or with another
surface is queued under its own id, with its own readiness signal and requirements, because a url
does not determine which screen renders. A surface that overrides a discovered route
(`overridesDiscoveredRoute`) has the route's id, so the two are one entry.

**Test files.** A test file is a file under `uiFileGlobs` that is named like a test (`*.test.*` or
`*.spec.*`) or sits in a folder named `test`, `tests`, or `__tests__`. Both kinds follow one rule:
a test file is excluded only when usabl has looked at every place that could load it and found
none. "No import found" is evidence only when the search was complete. For each changed test file,
in this order:

1. **It is a UI file** when a surface lists it in its `files`, when a route entry file's import
   graph reaches it, or when a file that is not a test file imports it, directly or through other
   files. For the last check usabl builds a wider import graph that starts at every file the
   config names as app code: every file under `uiFileGlobs` that is not a test file, every route
   entry file, the router file, every file `wideBlastGlobs` match that is not a test file, and the
   `files` of every surface, inside `uiFileGlobs` or not. So the answer holds when routes have no
   entry file, as with the router fallback, and when the router file or `src/main.tsx` sits
   outside `uiFileGlobs`. This graph reads imports more fully than the route graph: imports across
   several lines, re-exports, imports for side effects, `require()` of a fixed path, and bare
   imports that a configured alias maps, whatever its prefix. It is built only when a changed test
   file is not already reached by a surface or a route closure, so a run whose change holds no test
   file reads nothing more. A test file that is a UI file is planned like any other UI file: a
   route closure maps it, a surface rescues it, or it is an `unresolved` gap. So a screen component
   kept in `src/tests/`, or in a file named `Widget.spec.tsx` that a screen imports, is checked when
   it changes. When such a gap comes only from importers no route closure reaches, such as a story,
   a setup file, or a mock that imports a fixture, the reason names those importers and says so,
   and says that the gap stays until they are named like a test or sit in a test folder.
2. **It is an `unresolved` gap** when a load usabl cannot follow, in any file the wider graph
   followed, may load it:
   - an import usabl could not resolve whose last path segment, with or without its extension,
     equals the file's name without its extension (or its folder name, for an `index` file). For
     example, `src/pages/Home.tsx` imports `@/tests/Dashboard` with no alias config, so a change to
     `src/tests/Dashboard.tsx` is a gap;
   - an `import.meta.glob` or `import.meta.globEager` call whose pattern matches it. A string
     with a backslash escape is read as the string it is. Brace groups are expanded first, and each
     alternative is resolved on its own, so `./{../tests,x}/*.tsx` covers `../tests/*.tsx` and
     `x/*.tsx`. A relative alternative is resolved from the importer's folder. One that starts with
     `/` is resolved from the Vite root, as Vite reads it, when usabl knows the root: exactly one
     Vite config sits on the climb from the router file to the repository root and its text does
     not hold the word `root`, so the root is that config's folder, or no Vite config sits there,
     so the root is the repository root. Otherwise Vite's root depends on its `root` option or on
     how it is started, so such a pattern may load any file. Patterns are matched with usabl's own
     glob matcher. Every literal pattern in the call is read, an array of patterns too, and a
     negative pattern is left out, which can only name more files. A pattern with syntax the
     matcher does not evaluate, such as `?`, `[ ]`, `( )`, or a brace range, covers every file in
     the folder above its first such segment, so `/src/pages/[id]/*.tsx` covers `src/pages/` and
     not a test folder beside it. Each of these may load any file, and the reason says which it
     was: a call whose argument is not a string or a list of strings, a pattern that starts with an
     alias usabl cannot map, a call whose options set `base`, and a pattern usabl cannot read
     exactly (a nested or unbalanced brace, more than 64 brace alternatives, or a `..` after a
     segment with glob syntax);
   - an `import()` or `require()` whose argument is a template literal or is not a literal, and a
     webpack `require.context(folder, ...)`. The fixed text before the first `${`, or the folder, is
     a prefix, resolved from the importer's folder (or through an alias, or under a `baseUrl` for a
     bare start), and the call may load any file under it. A call with no fixed start, or whose
     argument is not a string at all, such as `import(name)` or `require('./tests/' + name)`, may
     load any file. A bare fixed start that names a whole declared package, such as
     `` import(`@patternfly/react-icons/dist/esm/icons/${name}`) `` with that package declared,
     loads no file of the app. A bare fixed start that no package explains, such as
     `` import(`tests/${name}`) ``, may be an alias usabl did not read, so the call may load any file
     with a folder or name in its path that starts with it;
   - a bare import, such as `tests/Widget`, that a `baseUrl` resolves to it. The compiler reads
     `baseUrl`, but a bundler reads it only with a plugin, and usabl cannot tell which one the build
     uses, so the import is not followed. The `baseUrl` is read from `tsconfig.json`,
     `tsconfig.app.json`, and `jsconfig.json`, in the folder of the nearest tsconfig at or above the
     router file and in the repository root;
   - a bare import that no package explains: a `#` specifier, which package.json `imports` maps and
     which is never an npm package, or a name that is not a Node.js built-in module and whose
     package (its first segment, or `@scope/name`) is not declared in the dependency fields of a
     package.json usabl reads: the ones on the climb from the router file, the `uiFileGlobs`
     folders, and each surface file up to the repository root, and every workspace package the root
     lists. A built-in is matched by the whole specifier, or its `node:` form, against Node.js's own
     list, so `fs/promises` is a built-in and `util/tests/Widget` is not. Such an import may be an
     alias usabl did not read, so it may load a file its last segment names, as an unresolved
     import does. A bare template start counts as a package only when it names a whole declared
     package, never a built-in, because the rest of the path is not known;
   - a bare import of a path inside a workspace package, such as `@acme/ui/testing`, that names no
     file under the package folder. It may go through the package's `exports` map, which usabl does
     not read, so it may load any file of that package. A path that does name a file there, such as
     `@acme/ui/src/tests/helpers`, is followed to it like any import.

   Loads inside comments are skipped. usabl finds the comments by parsing the file, so a string that
   holds comment marks, such as `"http://"`, never hides a call, and a file that does not parse, such
   as a `.vue` file, keeps every call.

   A file that such a load may reach through its own imports counts too: a glob that loads
   `src/tests/Index.tsx`, which re-exports `./Widget`, may load `src/tests/Widget.tsx`. The import
   graph records these loads in its `unresolvable` list as the kinds `glob-import`,
   `dynamic-import`, `base-url`, `bare-unknown`, and `package-subpath`. The gap reason names the
   file that loads files in a way usabl cannot follow and what usabl read of that load, says this
   file may be one of them, and says where the fix belongs: change the load in the named importer
   so its pattern or path start does not cover test folders, or make it a plain import usabl can
   resolve; or, if a screen does render the file, list it in the `files` of a surface.
3. **Otherwise it is excluded**, listed in `coverage.excludedFiles` with a reason for its kind (named
   like a test, or in a test folder) that says usabl found no import of it in the files it follows
   from this configuration, and no load it could not follow could reach it. Those files are the
   ones the wider graph reads, so the limits below apply to that sentence. Such as
   `src/test/setup.ts`, a helper in `src/__tests__/`, a mock request handler in `src/test/`, or a
   `Button.test.tsx` that only the tests import. It is not a gap, so a pull request that edits only
   tests still has nothing to check. A glob pattern that does not match the file, or a template
   prefix that does not cover it, changes nothing. A test file that `wideBlastGlobs` match is still
   a test file, so the match does not make it checked; its reason says it matched and was still
   not checked, because nothing outside the tests loads it.

A changed test file outside `uiFileGlobs` that sits in a workspace package the app depends on (see
"Workspace packages at check time" below) follows the same rule. The starts are the app's own, as
above, and the source files that are not test files of every workspace package the app depends on,
so a package that imports the file by a path inside its package counts. When a file outside the
tests loads it, or a load usabl cannot follow may reach it, it keeps the `not-covered` workspace gap
a file of that package gets. Otherwise, as for a file that only the package's tests import, it is
excluded and listed, and a change to it alone has nothing to check. When the workspace root cannot
be read, the package is not known, so the file keeps its gap.

Every list is sorted, and nothing depends on the order the file system returns files in.

`usabl baseline` and `usabl docs --all` pass every UI file through the same planner, so test files
are placed there by the same rule. A test file that is a gap there makes `usabl baseline` refuse to
write a floor unless `--partial` is given, because a floor must not claim a scope usabl could not
place. The loads that cause it most often cover many test files at once: `require(name)` or
`import(name)` with no fixed start, `import.meta.glob(variable)`, a glob or a `require.context`
whose folder holds a test folder, and a story, setup file, or mock that imports a fixture. The ways
out are `--partial`, a narrower load in the named importer, or a surface that lists the file.

The excluded files are shown on every surface, marked as not blocking, on any run, an idle one
included. `usabl check` prints them under "excluded files, not checked". The pull request comment
prints them under "Excluded files, not checked", each name and reason in a code span inside one
untrusted frame. The Stop hook prints each one as a framed piece labelled "excluded, not checked",
after every other piece. All three group files that share a reason, print the reason once, and name
the first 20 files, then count the rest; the JSON output holds the full list. On an idle run that
excluded files, the idle line says "Every changed file usabl would check was left out on purpose"
in place of "No UI files changed", and the pull request comment and the Stop hook add a sentence
that says how many files usabl left out and that a screen that renders one was not checked, so the
run does not read as plain nothing to check. Near the comment's size bound, the excluded files are
cut before any gap or finding, one group at a time, and a line counts the groups cut. A separate
line counts the files past the list of 20, and says that is what it counts.

This rule has limits. usabl does not try to detect these loaders, and a test file loaded only
through one of them is excluded:

- an importer outside `uiFileGlobs` that the config does not name: not the router file, not a
  file `wideBlastGlobs` match, and not a surface file;
- a loader that leaves no import text: a bundler plugin, a virtual module, a path string built far
  from the import (assigned to a variable in another file, then loaded), or an HTML file that loads
  a script from a test folder;
- a bare import of a name that a package.json usabl reads does declare, which an alias usabl
  cannot read also maps, such as a webpack or Babel alias, so the bundler loads an app file in
  place of the package. The package names are read from the working tree, which in CI is the pull
  request tree, so a name an earlier change declared can make a later import of an app folder by
  that name read as a package.

If a screen renders a test file, list it in the `files` of a surface, which makes it a UI file
whatever usabl finds.

**Files usabl cannot place.** Each file in `unresolvedFiles` gets an `unresolved` gap whose ref
is its repository path. The reason says why usabl could not place it, then the fix: add it to the
`files` of a surface in `usabl.config.json`, or add the route that renders it to
`usabl.routes.json` with an `entryFile` that imports it. Any import usabl could not follow on the
way comes last, as discovery detail, in three labelled groups: the imports on the screens' paths
that may load the file (one whose last segment names it, or a glob, dynamic, or `require.context`
load that covers it; the route graph does not record `baseUrl` or bare loads), then the file's own
imports, then every other import on the screens' paths, labelled as imports of other files that
may still load this one. The first three entries are printed, in that order, and then the count of
the rest. A test file that is a UI file only because files no route closure reaches import it
gets the note that names those importers in place of the fix. The reason never calls the file
changed, because `usabl baseline` passes every UI file through the same planner. A docs source
gets the docs form of the fix: add it to a
page's `sources` in `usabl.docs.json`, or to its `sharedGlobs`. The common case is a shared file,
such as a layout every route imports through an alias usabl does not resolve. `usabl check` names
the first such file in its gap list and then lists every other one with its reason, sorted.
`usabl baseline` scans every UI file, so it is where these show up first: its refusal on
incomplete coverage, and its `--partial` report, list such files with their reasons, sorted: the
first 20, then the count of the rest, the same bound `usabl check` uses. No page text is printed
in either list, and every line goes through the surface scrubber, because a path or an import in
source can hold credential-shaped text or a forged frame marker.

An import with no extension is probed against a fixed list: `.mjs`, `.js`, `.mts`, `.ts`, `.jsx`,
`.tsx`, `.vue`, and `.svelte`, then the same names as `index` files in a directory. usabl does not
read `resolve.extensions` from the Vite config, because it cannot run the config. When more than
one candidate exists, for example `Widget.vue` beside `Widget.tsx`, usabl does not pick one: the
import links every candidate, so a change to any of them maps to the screen. That can scan a
screen that does not render the changed file, and never leaves out one that does. The ambiguity
is still disclosed: the gap of a changed file that maps to no screen names every candidate of an
ambiguous import on its way. Write the import with its extension to resolve it.

An import with an extension loads the file of that name when it exists. When it does not, a
`.js` import is read as the TypeScript file the compiler and the bundler load for it, `.ts` or
`.tsx`, as is `.jsx` for `.tsx`, `.mjs` for `.mts`, and `.cjs` for `.cts`, at every depth of the
graph. So `./Child.js` beside `Child.ts` links `Child.ts`. When both `.ts` and `.tsx` exist, the
import links both and discloses the ambiguity, as above. A name with a dot but no module
extension, such as `./Widget.spec` or `./Button.styles`, loads the file of that exact name when it
exists, and otherwise is probed against the list above like a name with no dot, as the bundler and
the compiler do. So `./Widget.spec` links `Widget.spec.tsx`.

A template literal with a `${...}` part inside `import()` is not read as a file name. It is a path
built at run time, recorded as a load usabl cannot follow (see "Test files" above).

An `@/` or `~/` import resolves through two sets of path aliases. usabl finds two folders on
their own: the nearest folder at or above the router file that holds a `tsconfig.json` or a
`tsconfig.app.json`, and the nearest one that holds a Vite config. Each is the repository root
when no folder below it holds one. The tsconfig and the Vite config in those folders give the
app's set. When either folder is below the root, the root `tsconfig.json`, `tsconfig.app.json`,
and Vite config give a second set, read as they were before usabl looked in app folders, so
aliases are never read from fewer places. usabl cannot run the build to learn which set the app
uses. An import that the two sets map to different places resolves at each, every file found is
linked, and coverage discloses it in `discoveryNotes`, printed as discovery notes that do not
block. Within one set, a Vite alias comes first, in the order the config declares it, because
the bundler applies it before anything else, so a Vite wildcard alias wins over a tsconfig entry
for the same prefix. tsconfig `paths` fill in the prefixes Vite does not set. A tsconfig
`extends` chain is followed through relative paths, nearest config first: `paths` comes whole
from the nearest config that sets it, and its targets are read from the nearest `baseUrl`, or
from the config that sets `paths` when no config sets one. An extends that names a package, such
as `@tsconfig/node20`, is not read, because it resolves through `node_modules`. A `paths` entry
with no wildcard, such as `"@/theme": ["src/styles/theme.ts"]`, maps that one specifier, and
among the tsconfig entries it matches before a wildcard. An alias usabl does not read leaves its
import unresolved, which is disclosed, never a silent pass. One case is not disclosed: an extension outside
the list, such as `.web.tsx` added through `resolve.extensions`, is never probed, so a sibling
with that extension is not seen and the file usabl did find is attributed.

### Nothing to check vs not covered

Coverage answers two different questions.

**Nothing to check** (`coverage.nothingToCheck === true`): no changed file is a UI file (it
matches `uiFileGlobs` and is not a test file, see "Test files" above), no changed path looks
quoted, no test-folder file is a gap, no changed file is a dependency change of the app, and no changed file maps to a
documentation page under a `usabl.docs.json` manifest. There was nothing to prove. `Result.verdict` is `null`,
exit 0, and an explicit "nothing to check" message. A backend-only PR, a prose change
with no manifested doc page, and a clean tree with no diff are this path. This is not
`not_covered`. A change to an `.adoc` source that maps to a documentation page is a
docs-profile check, not idle (see below).

**`not_covered`:** UI files changed, and the tool could not identify or exercise what
they touched (unmapped file, unresolved import, screen failed to load, check
incomplete). That blocks. Idle and unmapped must never share a verdict.

If some UI files map and others do not, the run is `not_covered`. Partial proof is
not `verified`.

### Prove what you touch

Only changed files trigger checks. A file you did not touch is not a usabl problem
this PR. Coverage grows as the team works, not as a boil-the-ocean inventory.

### Documented limits

- Bundler aliases (`@/`, `~/`) are not resolved. They become `unresolvedFiles`.
- Computed import specifiers (`import(variable)`) are not resolved.
- Comment stripping in the import graph is regex-based and imperfect.
- A route the router reader cannot resolve is a named gap with its file and line (see below).

Those four are honest `not_covered` outcomes, not silent passes. The next section says exactly
what the router reader reads, what it reports, and what it still does not see.

#### Reading routes out of router source

With no `usabl.routes.json`, usabl reads routes from `discovery.routerFile`. It parses the file
with `@babel/parser` (TypeScript and JSX by the file's extension, legacy decorators always, and
Flow types for a `.js` or `.jsx` file that does not parse without them) and walks the syntax tree. It
does not run the file and it does not follow imports. Strings, comments, and regular expressions
are not code in the tree, so a commented-out route, a `>` or `)` inside a string, a regular
expression such as `/[//]/`, and a `createBrowserRouter(` written in a string or a comment are
never read as router code.

**What counts as the router.** Routes are read only from:

- the children of a `<Routes>` or `<Switch>` element, through nested `<Route>` elements,
  fragments, `cond && <Route />`, `a ? <Route /> : <Route />`, arrays, and a `const` in the same
  module that holds JSX;
- the first argument of a real call to `createBrowserRouter`, `createHashRouter`, or
  `createMemoryRouter`: an array of route objects, a `const` that holds one, a spread of such a
  `const`, and nested `children`. A local name for one of these counts too: an import alias such
  as `import { createBrowserRouter as makeRouter }`, a `const` that holds one, and a `const` made
  by a call that takes one, such as `Sentry.wrapCreateBrowserRouterV6(createBrowserRouter)`;
- the argument of `useRoutes`, read the same way as a route object list;
- the JSX passed to `createRoutesFromElements` or `createRoutesFromChildren`;
- a route config array rendered through `map` inside one of the routers above, as in the
  PatternFly seed: `{routes.map(({ path, element }) => <Route path={path} element={element} />)}`.
  The callback must return one element, with no children and no spread, whose `path` is the
  item's `path` (a destructured name or `item.path`). The list must be a `const` array literal in
  the module, reached directly or through `reduce`, `flatMap`, `flat`, or `filter`. Its objects
  are read like data router objects. The callback renders only the items it is given, so nested
  lists under `routes` or `children` are read only when the list passes through `reduce`,
  `flatMap`, or `flat`, which can bring them to the top level. Then an object with only a `label`
  and nested `routes` is a group, and its children keep its parent's path. Otherwise usabl reads
  the top-level objects, leaves the nested ones out, and reports the list as `assumed` (below).

A path object anywhere else in the module is not part of the router and is not read. A `<Route>`
anywhere else is not scanned either, because it may be a decoy, but it is named as an unreadable
entry with its line, because it may be real: the older pattern of a `<Route>` beside a `<Switch>`
for a modal is one example. When the module has `<Route>` elements or `path:` objects but no
router at all, usabl cannot tell which of them are real, so it reads none and reports one
unreadable entry for the whole file.

**What counts as a path.** A path is read when it is a string, a template with no expressions, or
a reference to a `const` in the same module whose value is one of those. A member of a `const`
object counts, such as `ROUTES.home` or `ROUTES['admin'].users`, including an object wrapped in
`as const`, `satisfies`, or `Object.freeze`. A name bound more than once in the module, such as a
module `const` shadowed by a parameter, is not resolved, because telling which binding a
reference means needs scope analysis the reader does not do. An object with a property assigned
or deleted anywhere in the module is not resolved either. A `const` route list or route tree that
is changed in place anywhere in the module, by an index assignment or by `push`, `unshift`,
`splice`, `pop`, `shift`, `fill`, or `copyWithin`, is not read: it is one unreadable entry where
the router uses it, not a partial read. In a route object, a method such as `loader()` or
`action()` is not a path and is skipped. A spread, or a method named `path` or `children`, makes
the route unreadable when it could supply the path or the child routes, that is, unless `path`
and `children` are both written after the last spread. A relative path is joined to its
parent route's path, as React Router does: `settings` under `/app` is `/app/settings`, and an
index route has its parent's path. At the top of a data router, and of a `<Routes>` element that
is the only router in the file, a relative path is relative to `/`. A bare `*` route is the
not-found page, which is not a screen, and is skipped. A path that ends in `*` after other
segments, such as `/app/*`, matches many URLs and usually mounts routes declared in another
file, so it is reported (below) rather than scanned as the literal URL `/app/*`.

**What it assumes.** usabl does not run code, so a route config list that reaches the map through
`reduce`, `flatMap`, `flat`, or `filter` is read as if every route object in it is rendered. So
is a list whose nested relative paths it joins to their parent's path, a plain list whose nested
route objects it left out, and a list rendered through an element that is not `<Route>`, such
as a v5 wrapper inside `<Switch>`. Each such list
is an `assumed` entry with the line of the map call. `usabl init` writes it as a `Review:` note
with the file and line and keeps the routes in the draft. When the code does more than flatten or
select, for example when it rewrites paths, the draft can name URLs the app does not serve, which
is why init asks the operator to check. With no sidecar, nothing has checked the assumption, so
the router fallback reports each `assumed` entry as an `unreadable` entry (below) with its own
reason and an id. The planner still queues the routes it read on a wide-blast change, and records
the entry as a `skipped` gap, so the run is not covered. `usabl drift routes` refuses on it until
the sidecar acknowledges its id.

**What it reports.** A route it finds but cannot read is never dropped. Each one is an
`unreadable` entry with the router file, the line, and the reason: a path it cannot resolve (an
import, an expression, a template with expressions, a `let`), a route that takes its props from a
spread or a computed key, routes built by code (`routes.map(...)`, a function call), an element
among the routes that is not a `<Route>`, a relative path whose base it cannot tell (for
example in a file with more than one router), a path such as `/app/*`, a `<Route>` outside every
router it read, a route list changed in place, a call whose name ends in `Router` that is not one
of the known factories or a name for one, and a wrapper of a known factory that it cannot follow.
A router file that does not parse is one entry for the whole file, with the line and column of
the syntax error, and no routes. So is a file with routes but no router. Then:

- the planner records each entry as a `skipped` coverage gap whenever a wide-blast change would
  have queued the router's routes, so the gate reads the run as not covered. Router routes have
  no entry file, so wide blast is the only way they are scanned, and a run with no wide-blast
  change never depended on them;
- `usabl drift routes` lists each entry with its file, line, and id, and exits 2, because
  neither "no drift" nor a removal can be confirmed. Once the sidecar's author has checked an
  entry by hand, they can acknowledge it in `usabl.routes.json` (below). An acknowledged entry is
  still listed and no longer forces exit 2;
- `usabl init` writes a `Review:` note for each entry with its file and line, because the draft
  sidecar does not list that route and usabl never scans a route the sidecar leaves out.

**Entry files.** `usabl init` attributes an entry file only to a leaf route, one with no child
routes, that sits in a router the module defines. A layout route with children gets no entry
file, because its component also renders on every child's URL, and a change to it must not read
as covered by one screen. The route names what it renders in one of these ways:

- a JSX route's `element={<Name />}`, including JSX passed to `createRoutesFromElements` and
  `createRoutesFromChildren`;
- a route object's `element: <Name />` or `Component: Name`, in a router factory call or in
  `useRoutes`;
- a data router route object's `lazy: () => import('./module')`, which names the module itself.
  The loader must make exactly one dynamic import of a plain string; `.then(...)` and an async
  function that awaits it count;
- a route config item's field that its map callback renders: `element={item.element}` reads the
  item's `element: <Name />`, and `element={<C />}` or `component={component}` reads the item's
  `component: Name`. A field the callback does not render is never read.

`<Suspense>` around one element counts as that element. A lower-case name is an HTML element, not
a component. `Name` must be imported, or be a `const` made by React's `lazy` from one dynamic
import, such as `const Reports = React.lazy(() => import('./pages/Reports'))`. A relative
specifier is resolved from the router file. Any other is resolved only through a tsconfig
`paths` entry or a Vite `resolve.alias` the project configures, such as `@app/*` to `src/app/*`;
a package import resolves to nothing. When two sources for one path name different components
or modules, neither is attributed.

An import is tried the way bundlers try it. A written `.js` names `.js`, `.ts`, or `.tsx`, the
TypeScript ESM style; `.jsx` names `.jsx` or `.tsx`; `.mjs` names `.mjs` or `.mts`; `.cjs` names
`.cjs` or `.cts`. An import without an extension is tried as `.tsx`, `.ts`, `.jsx`, and `.js`,
and then as a directory's `index` file with the same extensions. A file always wins over a
directory index. When more than one file matches at the same step, the route gets no entry file
and a `Review:` note names every candidate, sorted, because the bundler's pick depends on an
extension order init cannot read. Every route init cannot attribute is named in a `Review:` note
with the router file and the line of its path.

**What it still does not see.** These leave no gap, so check for them:

- routes kept in another module, such as an imported route array. The router file's reference
  to it is reported, but the routes inside are not read;
- file-system routers, such as Next.js `app/` and `pages/` folders. There is no router file to
  read;
- a descendant `<Routes>` element in another file, which only exists at run time;
- a router file with no router and nothing route-shaped: no `<Routes>`, no router call, no
  `<Route>`, and no `path:` object. It reads as no routes, the same as a missing router file;
- a router factory with a name that does not end in `Router` and that is not an alias or a
  wrapper of a known factory, such as `makeApp([...])`. Its routes are not read and not named;
- an object or a route list changed by passing it to a function, such as
  `Object.assign(ROUTES, extra)` or `addRoutes(routes)`. Only assignment, `delete`, and the array
  methods listed above are noticed.

**Acknowledging an entry in drift.** A common router has entries usabl cannot read, such as a
`/app/*` route, a guard element like `<RequireAuth>` among the routes, or routes built with
`map`, so `usabl drift routes` would refuse on every run. Each entry that is one declaration
carries an `id`: a 12-character hash of that declaration's source text and the reason. It stays
the same when other lines move and changes when the declaration changes. To acknowledge entries,
list them in the sidecar:

```json
{
  "routes": [ ... ],
  "acknowledgedUnreadable": [{ "file": "src/App.tsx", "id": "3f2a9c1b0d4e" }]
}
```

Only `usabl drift routes` reads this list. Coverage planning never does, because with a sidecar
present it does not read the router at all. A whole-file entry (a router file that does not
parse, or one with routes but no router) has no id and is never acknowledged. An acknowledgement
that matches nothing is listed so it can be removed. `usabl.routes.json` is a guarded file, so
adding an acknowledgement needs the same owner review as adding a route.

What an operator can do. Write the routes into `usabl.routes.json`. An authored sidecar takes
precedence over router-source discovery, so the manifest is exactly what that file says and none
of this applies. `usabl init` drafts the sidecar with this same reader, so read the draft and its
`Review:` notes against the router before merging it, and add any route it names.

#### Limits of detecting that a screen was not reached signed in

A scan of a login-gated application can be handed the application's sign-in experience instead of
the screen it asked for, and score it as that screen. Measured on a real application with an
expired session: usabl filed the sign-in page's barriers under the requested screen ids, disclosed
nothing, and reported all twenty-nine barriers on the committed evidence floor as resolved. The
run was red only because that page carried barriers of its own; a clean one would have returned
verified, with a receipt, and a claim that the accepted debt was gone.

That application never leaves the requested address. It renders a blank shell for over five
seconds, then swaps a login form in at the same URL, so neither the address nor the presence of a
password field is reliable on its own. Its own API calls to identity endpoints answer 401.

Two layers now stand against this, and neither closes the hole completely.

**Where the session comes from.** In order: a storage state path a library caller passes, then the
file the `USABL_STORAGE_STATE` environment variable names, then the file `usabl session` saved at
`.usabl/session/storage-state.json`, when it exists. `buildDeps` resolves it, so the CLI, the dev
overlay, and the Stop hook all use the same one. `usabl session` opens a headed Chromium at the
origin of `appBaseUrl` (never its path or query), waits for the person to press Enter or close the
tab, and saves the Playwright storage state. It refuses with exit 2 before the browser opens, and
again right before the write, unless git ignores the path, and the refusal names the line to add to
`.gitignore` (`.usabl/`) or, for a tracked file, `git rm --cached`. The folder is made 0700 and the
file 0600, written to a temporary name and renamed. It saves nothing, and says so, when the browser
quits before usabl can read the session or the browser holds no cookies and no site storage. It
prints only the path and how many cookies and sites the file holds. A run uses the saved file only
when git ignores it: a file git tracks or would commit stops the run with no verdict (exit 4) and
the fix. The saved file is never loaded when a trusted ref is set or in CI (the `CI` variable),
because there the code under review can write it and ignore it; only `USABL_STORAGE_STATE` signs
in, and the run says once on stderr that it skipped the file. A saved file other users can read
is used, with a warning on stderr that names `chmod 600`.

**Before the browser opens.** When the session file, named by the variable or saved by `usabl session`, is one in which every cookie carries
an expiry, every one of those is already past, no origin holds local storage or IndexedDB, and
there are no stored credentials, there is nothing left in it that could authenticate. The run stops
with no verdict (exit 4). The bar is deliberately "nothing here could possibly work" rather than
"probably dead": one session cookie, one undated cookie, one IndexedDB entry, one local storage
entry, or one virtual authenticator credential means the file cannot be judged and is not refused.
Playwright restores all four of those stores, so any of them could be carrying the session. A
missed dead session is caught below; a false refusal has no backstop.

**At scan time.** Three rules, each producing a `not-covered` coverage gap on that screen. A gapped
screen contributes no findings, records no keyboard walk, and is excluded from the cleanly-scanned
set the gate is given, so no floored barrier on it can be reported as resolved.

- **Rule A, refused data requests.** A storage state is configured and at least one of the page's
  own `fetch` or XHR requests to the application's own hostname had answered 401 at either of two
  reads: the first when readiness settles, the second after the walk, the checks, the source
  attachment, and the reachability measurement have run. A refusal that arrives after the second
  read is not seen. This is the primary signal, because it needs nothing from the address or the
  DOM. Two reads, not one: readiness needs four equal DOM counts 500 ms apart plus 500 ms of
  network quiet, so a stable shell settles in about 1.5 s, and an application that sends its
  identity request later than that has sent nothing yet. Measured with the real adapter, a page
  fetching its identity endpoint at three seconds recorded nothing at the first read. The second read deliberately includes traffic the
  providers caused, because a request a provider click triggered is still the application answering
  this session. 401 only; 403 means authenticated and not permitted, which a correct signed-in scan
  can legitimately meet.

  One thing stands a refusal down, a token refresh, and it takes all of these together:

  - The screen's readiness signal (below) declares a `response` path. A selector on its own, which
    is what the string form of `reachedWhen` is, never stands Rule A down. That is the behaviour
    from before recovery was read at all.
  - That path was answered with a 2xx that is not an HTML page, by a request sent before the walk
    began, at an address that was never refused in this record.
  - A declared selector did not fail when the page settled.
  - The last answer the page recorded for each refused address was a 2xx that is not an HTML page.

  The address is compared without its fragment and with its query, so a retry with a different
  query does not count, and a success on a different address, such as the refresh call itself,
  never recovers a refusal. No one fact is enough. A 401 followed by a 200 can be an application
  that dropped its stale token and was answered as an anonymous visitor. The "never refused" part
  stops one 200 from doing two jobs: a wall that refuses `/api/users?page=1` and then answers the
  anonymous retry of that same address would otherwise hold a `/api/users` signal and recover the
  refusal with the same answer. So on a screen with no response path, a refusal followed by a
  success is still a gap, exactly as before.

  What this still cannot catch: an application that answers an anonymous visitor with a 2xx, not
  HTML, both on the refused address and on the declared data path. To usabl that reads the same as
  a token refresh. Pick a response path that only a signed-in session can get a success from.

  The host match. A refused request counts when its hostname equals the `appBaseUrl` hostname, or
  ends with a dot followed by it, regardless of scheme and port. So `api.example.com` counts for
  `example.com` and `notexample.com` does not. Comparing origins instead was too narrow in three
  ways that all happen in practice, and each was measured flowing through a real run to a verified
  receipt with a paid-down entry: a different port, a different scheme, and an API subdomain. When
  `appBaseUrl` does not parse there is no hostname to compare against, and then every
  page-initiated 401 counts. That is deliberate: a base URL usabl cannot read is a configuration it
  cannot reason about, and `not_covered` is the honest outcome where counting nothing would hand
  back a verdict.
- **Rule B, a password field anywhere.** A storage state is configured and a password input exists
  anywhere in the page, in any frame or inside an open shadow root. The address is not consulted.
  Overridden by `reachedWhen`: when the surface declares a readiness signal and every part of it
  holds at the time of the check, this rule does not fire. A change-password screen, or a settings
  page with a re-authentication prompt, is exactly the case the override exists for.
- **Rule C, redirected to a sign-in page.** The browser ended on a different address than the one
  requested and that page carries a password input. This applies whether or not a storage state was
  configured, because a redirect to a sign-in page is the wrong page either way.

The two session rules require a configured storage state because only that is an assertion that the
run is signed in. Without it a 401 and a login form are ordinary things for a signed-out visitor to
meet, and firing on them would turn every deliberate signed-out scan into a gap.

**`reachedWhen` is operator-supplied policy, not independent proof.** It is a CSS selector an
operator wrote, and usabl cannot check that it names what the operator meant. A selector that
matches a persistent application shell, a header, a navigation, or a footer is present on a login
wall too, so declaring one of those does not assert that this screen rendered; it asserts that the
application's chrome rendered, which it does on the sign-in page as well. Such a selector will let
Rule B pass the wrong page, and it will do it silently, because a matched selector reads as
success everywhere it is consumed. To be worth anything the selector has to name content only this
screen has: that screen's own table, its own heading, its own empty state. The config loader says
so when it refuses an empty value, because config load is the last place an operator reads anything
about this field.

That is also why the override does not extend to Rule A. A same-host 401 with a configured session
is the application itself saying the session was refused, which is stronger evidence than any
selector an operator wrote. Only the application later answering that same address stands it down,
and only with the signal held.

**The readiness signal.** `reachedWhen` on a surface is positive evidence that the screen really
rendered. It is general: it answers "did this screen render", not "is the session alive", so it
applies with or without a configured storage state. It takes one of two shapes:

```json
"reachedWhen": "table#users"
```

```json
"reachedWhen": { "selector": "table#users", "response": "/api/users" }
```

The string is a CSS selector on its own. The object declares a `selector`, a `response`, or both,
and every part it declares has to hold.

- `selector` holds when it matches at least one element in the rendered page. A selector the
  browser rejects matches nothing, so it does not hold.
- `response` is a URL path. It holds when one of the page's own `fetch` or XHR requests to the
  application's own host answered with a status from 200 to 299, and the request path is that path
  or continues it after a slash. The host match is the one Rule A uses: the `appBaseUrl` hostname
  or a subdomain of it, on any scheme and port. The query string is never compared. So `/api/users`
  holds for `/api/users?page=2` and `/api/users/42`, and not for `/api/users-archive`. A document,
  stylesheet, image, font, or script response never counts, because an authentication wall answers
  200 to those too. When `appBaseUrl` cannot be read, nothing counts. The config loader refuses a
  `response` that does not start with one slash, that starts with two, that is `/` alone (every
  data request on the host would satisfy it), or that carries a query, a fragment, whitespace, a
  control character, a backslash, or a `.` or `..` segment, plain or percent-encoded. URL parsing
  reads a backslash as a slash, resolves dot segments, and strips a trailing control character, so
  each of those is compared as a different path from the one written, and most of them as `/`. It
  also refuses any path that URL parsing turns into `/`. The message does not repeat the value. It
  refuses an unknown key in the object, so a misspelled part is not silently dropped.
- Two more things decide whether an answer counts toward `response`. An answer whose
  `Content-Type` is `text/html` or `application/xhtml+xml`, with any parameters and in any case,
  never counts: a sign-in page, an SSO or proxy login, and a development server's history
  fallback all answer a data call with an HTML page and a 200. An API that really answers with
  HTML therefore never satisfies the signal, and the screen becomes a gap, which is the safe
  direction. An answer with no `Content-Type` counts. And only a request sent before the walk
  began counts. usabl marks that moment just before the first key press, so traffic a key press
  or a check caused never counts. A redirected request is dated by the request that started the
  chain.

**Readiness waits for service workers.** A service worker's requests are reported on the browser
context, not on the page, and its install and activation steps only through the browser's
debugging protocol. Content that waits for `navigator.serviceWorker.ready` mounts only after those
steps finish, and they can wait on a fetch. So the network counts as quiet only when the page's
own requests and its service workers' requests have all finished or failed, and no worker is
installing, waiting, or activating, or starting its script. A worker whose script was never
fetched, or failed to fetch, does not count, because the browser reports nothing more about it.
Measured through a real browser against a page whose button with no accessible name mounts only
after a worker's install step waits 20 seconds on a fetch: before, readiness read the page as
quiet and the shell was walked and checked with no finding and no gap; now readiness waits and
the button is reported. When the worker does not finish inside `readyTimeoutMs`, readiness runs
out on a busy network, and the screen is a `not-covered` gap whose reason names the service
worker request or install still running. A browser that cannot report its workers fails the open,
which is also a gap.

**Readiness waits for the selector.** A page can mount a small shell, do nothing at all for a
while (no request in flight and no change to the DOM), and only then fetch and mount its real
content. During that pause both readiness conditions really hold, so without a signal a pause
longer than about 1.7 seconds reads as a finished page. When a surface declares a `reachedWhen`
selector, readiness does not stop at the first moment the page is still and quiet. It checks the
selector at each such moment and keeps waiting until it matches at one of them, for at most
`signalTimeoutMs` (15000 by default) counted from the first moment the page settled, and always
inside `readyTimeoutMs`. The cap never restarts, and it is checked on every pass whether or not the
page has settled since, so a page that keeps changing cannot stretch it.
A match only ends the wait when the page reads the same after the check as before it: the same
element count, with the network still quiet. Checking the selector takes several reads of the live
page, and a page can mount its content during them. Then the moment the check started from was not
the page the selector matched on, so readiness keeps waiting, inside the same cap and budget, until
the page holds still again. Measured through a real browser against a page whose table mounts
during that check and, in the same task, sends a request that later mounts a button with no
accessible name: ending the wait on that match walked and checked the page before the button
existed, and the screen came out clean with no gap.
Readiness stops waiting early when the page is plainly not this screen, by the rules above (a
refused data request under a configured session, a password field with no signal that holds, or a
redirect to a sign-in page), so those gaps cost no more than before.

When the cap runs out before the selector matched at a settled moment, the screen is not walked and
not checked. It ends as a `not-covered` gap that names the selector and the cap and says to raise
`signalTimeoutMs` if the screen needs longer. The wait reports how it ended, and that outcome
decides, not a second read of the selector: an element can appear after the cap ran out on a page
that is still changing, and walking that page would grade something that had not settled. The cap
running out while the page is still changing is the same gap, never the `readyTimeoutMs` error.

Only the selector can end the wait. A response stays seen once its answer arrived, so it cannot tell
the screen's content from a page that replaced it a moment later. Measured through a real browser
against a page that pauses three seconds, fetches its data (200, JSON), mounts its table, and 800 ms
later replaces itself with a magic-link sign-in form: waiting on the response would end the wait
when the sign-in form settled, and the walk and the checks would grade the sign-in form as the
screen. So a screen that declares only a `response` waits exactly as a screen with no signal does.
What changed for it is when the response must arrive. Before this, both parts were read once, after
the walk and the checks, so a request sent before the walk and answered during it counted. Now a
declared response must have arrived before the walk began, and one that arrives during the walk
makes the screen a gap, because the screen's data was not there when the walk and the checks began.
After a pause long enough to end readiness, the screen's data request is sent after the walk began,
it never counts, and the screen is a gap. That is the honest outcome, and the fix is to add a
selector. That sign-in form page is a gap with a response alone, and a gap with a selector once the
cap runs out.

Measured through a real browser against a shell with one link that pauses for 1.5, 1.8, 2.1, and
4.0 seconds before it mounts its content: with a selector declared, the walk and the checks ran on
the content in all four cases. Before this, the 1.5 second pause was graded on the content and the
three longer ones ended as gaps, because the content arrived after the scan. With only a response
declared, the 1.5 second pause is graded on the content and the longer ones are gaps.

Both parts are then measured twice: once just before the walk, after that wait, and once after the
walk and the checks, while the page is still open. A part holds only if it held both times. The
walk and the checks are only evidence about the screen if its content was there when they began, so
a selector that first matches during them, because the content arrived late or a check opened it,
does not count, and neither does a response whose answer first arrived during them. The second
measurement catches a walk that navigated away from the screen. A part that does not hold marks the
screen unseen: its findings and applicability are dropped and it gets a `not-covered` gap that names
the selector or the path. The same signal, measured when the page settles and before usabl touches
it, is what overrides Rule B and what lets a recovered refusal stand under Rule A.

The cost is time, and only on a screen whose selector does not match: a sign-in page the session
rules cannot see, or a selector that names the wrong element. Such a screen now spends the signal
cap after it first settles before it ends as a gap. Measured through a real browser with the default
cap, a page whose selector never matched ended after about 17.1 seconds with no walk. Before, it
settled in about 1.5 seconds and ended as the same gap after a walk and the checks. A screen whose
selector matches pays nothing extra.

**Without a signal the pause is still not covered.** Measured through the same real browser with
no `reachedWhen`, the 1.8, 2.1, and 4.0 second pauses were graded on the shell and returned no gap.
Raising `readyTimeoutMs` does not help, because readiness believes the page is done and returns
before the budget runs out. Comparing what a screen showed with what it showed on an earlier run
would need a trusted record of that earlier run, and usabl has none that fits. The evidence floor
is trusted, because CI reads it from the trusted ref and a code owner reviews it, but it records
accepted barriers, not how many controls a screen rendered, and a screen with no accepted barrier
has no entry at all. The local receipt is not trusted for this: it is written by the stop hook on
the developer's machine, only after a verified run, it is not present in CI, and it records rule
counts, not controls. A run that was itself graded on the shell would write the shell as the
record. The answer for a screen with a late or slow mount is to declare `reachedWhen`.

`usabl init` recommends a signal for every surface it drafts when the application looks
login-gated: when `USABL_STORAGE_STATE` is set while init runs, when `usabl session` has saved a
session (init checks only that the file exists), or when a discovered route has a
sign-in path segment such as `login`, `sign-in`, `logout`, `auth`, or `sso`. It writes none itself,
because only the operator knows what each screen shows, and a guessed selector that a sign-in page
also matches would read as proof.

**What the signal catches.** Measured through a real browser against three sign-in pages served at
the address the scan asked for: a passkey prompt with one button, a magic-link form, and an
authentication wall that answers 200 to every request under it, including its own status call.
None makes a refused request and none has a password field, so the three rules say nothing, and
each has a real control to focus, so the body-only floor says nothing either. Each is scored as the
screen when the surface declares no signal. If the evidence floor holds barriers for that screen,
the run claims none of them fixed and shows a notice that names the screen (see "Absent is a fix
only with evidence" in section 9), but the verdict does not change. Each is a gap when the surface declares a selector for
the screen's own table, and each is a gap when it declares the screen's own data path, because
none of them renders that table or asks for that data. The same signal holds on the real screen.

**What is still not caught.** Without a signal: a server-rendered sign-in page that makes no API
calls and carries no password input (a passkey prompt, a magic-link page, an email-first identity
provider, a consent screen); an authentication wall that answers 200 to every request and renders a
branded landing page; a password field inside a closed shadow root or a cross-origin frame; a
sign-in wall whose API lives on an unrelated hostname; a sign-in page served at the very address
that was requested, with no storage state configured. The body-only detector catches only the
subset of these that render nothing focusable.

With a signal, these remain:

- A selector that a sign-in page also matches, per the paragraph above.
- A `response` the wall itself satisfies. If the application shell is public and runs its own
  script, its request for the screen's data reaches the wall, and a wall that answers that request
  with a 200 that is not HTML, such as an empty JSON body, satisfies the path. A wall is caught
  when its own page does not request the declared path, or when it answers that path with an HTML
  page. Pair the path with a selector for content that only real data renders.
- Content that mounts in two bursts with a still, quiet pause between them, when the signal names
  content from the first burst. Readiness returns once that content is there, and the walk grades
  the page without the second burst. Name content that only the finished screen has.
- A 401 that arrives after the second read, which is the last observation of the page before it
  is closed, so a response still in flight at that moment is never recorded.

A miss leaves exactly the behaviour that was there before, so none of this manufactures a new false
green of its own. Each rule can also fire on a screen that was genuinely reached: a same-host
endpoint that answers 401 where it means 403, every page-initiated 401 when `appBaseUrl` cannot be
parsed, a refusal the application recovered from on a screen with no `response` path, a signed-in screen
with a password field and no signal that holds, a stale configured URL. A signal that does not hold
on a genuinely reached screen is a gap too: a selector for content that loads only after the
signal cap runs out or only on interaction, a
`response` path whose data comes from a host that is neither the `appBaseUrl` hostname nor a
subdomain of it, which never counts, a `response` path an API answers with HTML, or one the page
requests only after the walk began, such as a poll. The cost of each is a coverage gap, so the run reports `not_covered` rather than a verdict it
should not have minted.

What an operator can do. Declare `reachedWhen` on the surface, naming content only that screen has,
a data request only that screen makes, or both. It is the answer for a screen these heuristics miss,
for a screen Rule B fires on wrongly, and for a screen whose identity call is refused once before a
token refresh. It is only as good as what it names: see the paragraphs above on what a shell
selector and a public shell cost.

#### A credential in a configured surface URL is refused, and a query is dropped where it is published

Text that comes off the page is sanitized before it is published. A coverage gap reason strips the
userinfo, the query, and the fragment from every address it names, and shortens a refused request
to the front of its path, because any of those can carry a token.

Exactly what a refused request discloses, so a reader can judge the risk rather than trust the word
"shortened": the scheme; the complete hostname, as punycode when it was written in unicode; the
numeric port when the address carries one that is not the scheme default; and either of the first
two path segments, and only while a segment starts with an ASCII letter, is at most 24 characters,
and contains nothing but lowercase ASCII letters, digits, dot, underscore, and hyphen. Everything
from the first segment that fails those tests is dropped and the tail is marked with an ellipsis. A
unicode path segment fails the character test and is cut. The consequence to take on board: a
secret that is short, lowercase, and sitting in either of the first two path segments WILL be
printed. `/reset/<token>` is cut because a token is normally mixed case or long, not because the
position is protected.

Configured surface URLs are not page text. `gap.ref`, `ScreenScan.url`, and
`coverage.affected[].url` carry the operator's own `usabl.config.json` value verbatim into the
Result, and from there into the overlay and the stop hook. That is deliberate: the overlay
attributes a gap to a screen by comparing these values exactly, so rewriting one would silently
orphan the gap it belongs to. The surfaces CI publishes are different. The CLI text, the JSON
Result that `usabl check --json` writes, and the pull request comment drop the userinfo, the
query, and the fragment from every URL in the Result outside its identity fields, the same way
`checkPage` output does. Nothing reads those surfaces back to match a gap to a screen, so
dropping them costs no match. The identity fields (`screenId`, `layer`, `rule`, `rules`,
`elementKey`, `elementPath`, and `surfaces`) keep their URLs as written, because floor and waiver
keys are matched against them byte for byte. The `usabl docs` report (JSON and `--html`) has no
such exception: nothing matches keys against it, so after generation every string in every docs
artifact, element paths included, loses the userinfo, the query, and the fragment of each URL in
it, and so does a content requirement's `selector` and `expectedText`. A docs element path that
held a URL is therefore not a working selector.

So the loader keeps the value and refuses what must not be published. A `surfaces[].url` or an
`appBaseUrl` that carries userinfo (`https://user:pass@host/screen`, or a user name alone) is
refused when the config is read, because every discovered route url is built from `appBaseUrl`.
The message names the field, such as `surfaces[1].url`, and never prints the value. Userinfo is
found three ways, and any one refuses the value. URL parsing finds it the way a browser does,
through a backslash for a slash or a tab inside the name. Two shape checks then run on every value,
with backslashes read as slashes: an `@` in the authority after `//`, and an `@` before the first
`/`, `?`, or `#`. The second catches a value with no `//`, such as `admin:secret@localhost:3000/x`,
where URL parsing reads `admin:` as a scheme and finds no password. An `@` later in the path, the
query, or the fragment is accepted.

A query string or a fragment is accepted, because applications select screens by both. The CLI,
the stop hook, and the dev-server plugin print a warning on stderr when they load the config,
once per process for each field and URL, so the dev-server plugin does not repeat it on every
save. It names the field, never the value, and says where the query and the fragment are still
printed.
The residual an operator has to know about: a preview token in the query, or anything in the
fragment, is still echoed by the overlay and the stop hook, and so reaches an agent transcript.
Do not put one in `usabl.config.json`. Reach a protected environment with a storage state, which
never enters committed config, instead.

### Documentation coverage

When a `usabl.docs.json` manifest is present, coverage extends to documentation the same
way it extends to UI. The manifest lists each page with its published `url`, its owning
`assemblyFile`, and the full `sources` closure of AsciiDoc files that render into it:

1. A changed `.adoc` file maps to every page whose `sources` include it.
2. A file matching the manifest `sharedGlobs` is a wide blast across all pages.
3. An `.adoc` file that maps to nothing becomes an `unresolvedFiles` gap and forces
   `not_covered`, exactly like an unmapped UI file.

The source closure is built by following real `include::` transclusions
(`asciidoc-include-graph.ts`). It over-approximates (it does not evaluate `ifdef`/`ifeval`)
rather than guessing narrow, and it ignores includes shown as code blocks or comments.
Manifest paths are validated: a page `url` must start with `/`, reject `@` and
percent-encoded traversal, and `assemblyFile`/`sources` are `..`-rejecting repo-relative
paths. `docsBaseUrl` is refused when it carries a user name or password, found by URL parsing,
by an `@` in the authority after `//`, or by an `@` before the first `/`, `?`, or `#`, with
backslashes read as slashes for the last two, the same readings `usabl.config.json` URLs get. Every
docs screen url is built on it and printed in the results, so the refusal names the field and
never the value.

### Source-aware findings

A finding on a rendered documentation page is mapped back to its AsciiDoc source after
the gate, presentation-only, by `mapFindingToSource` (`src/docs/source-map.ts`) in three
tiers:

- **renderer:** a `data-source-file` attribute (plus optional line) emitted by a
  cooperating Asciidoctor pass gives an exact file and line.
- **content:** match the rendered image, link, or heading text back to source for the
  file and construct (`image::`, `link:`, a `=` heading marker), without a line.
- **fallback:** attribute to the page's assembly file and disclose the whole source
  closure as candidates.

The mapping never throws and never gates. A writer sees the fix phrased in their own
markup, not a DOM selector; if the tool cannot place a finding, it says so.

---

## 9. Gate (verdict authority)

The single module that constructs a Verdict. No other module can. Overlay, mid-task
check, CI, and the Playwright helper present the Result; they never mint a verdict of
their own.

### Verdict computation

1. **Guard check first.** If any guarded path differs from the trust anchor, the
   verdict is `approval_required`. Affected UI still scans unless intake is
   malformed (the harness stays closed for unreadable requirements). A
   requirements file that does not load is also `approval_required`, even when
   it did not change. The summary names the two reasons apart:
   `approval required: N guarded path(s) changed` counts changed paths only, and
   `the requirements could not be loaded` is added when the load failed. Findings
   stay on the Result. No receipt. The gate also mints `accessibilityVerdict`
   and `accessibilityExitCode` (never 2) so CI can split policy approval from
   accessibility enforcement.
2. **Coverage.** If `nothingToCheck`, return `verdict: null`, exit 0, no browser, and
   a summary like "nothing to check (no UI-touching files)."
3. **Run checks.** For every affected surface, run providers, collect Drafts. Do not
   sample. If any affected surface cannot be fully exercised, `not_covered` - never
   mint a `verified` receipt on a partial scan.
4. **Filter by evidenceClass.** Only Drafts with `evidenceClass === 'deterministic'`
   participate in the verdict. Preview, model-judgment, and human-confirmed findings are
   surfaced in the Result but do not block or enable `verified`.
5. **Identity, dedup, differential, waivers.**
6. **Verdict priority order:**
   - Any new deterministic failure (`confidence: 'fail'`): `regression`.
   - Anything unverifiable (unreachable surface, incomplete check, unmapped file, or a
     new deterministic finding at `confidence: 'unverified'`): `not_covered`. Unverified
     is not a silent pass and is not a regression.
   - Everything else: `verified`.

   Status decides on both finding clauses, not just the failing one. A finding the
   evidence floor already accepted is `carried` and does not gate, whether it fails or
   could not be confirmed. Blocking on carried uncertainty would hold every large
   application at `not_covered` forever, because any real UI has some results a checker
   declines to judge and no work clears them. What stands between several barriers and one
   accepted entry is the recorded count, not the confidence, and it is a partial guard: see
   the residual section under Evidence floor. The floor
   stores how many barriers it accepted at an identity, and more than that comes back as
   `new` and blocks.

### Identity

Every Finding gets `{ screenId, layer, rule, elementKey, identityBasis }`.

Priority:

0. **row** - a control inside a keyed table row: the row's key, the control's role, and its
   place in the row. It comes first because repeated controls are exactly the ones a name or a
   count cannot tell apart: "Edit" in every row shares one name, and an unnamed icon button in
   every row has none. Only a version 3 floor is compared this way; see below.
1. **name** - a stable accessible name from evidence (survives markup churn).
2. **structural** - role plus the element path with nth-child indexes stripped.
   Weaker than a name; stronger than a volatile CSS path.
3. **count** - identity-weak. No per-element key. Compare `{screenId, rule}` by
   count. The floor key omits layer so axe and PatternFly reports of the same
   defect can collapse.

Identity-weak rules are an allow-list of "this element has no accessible name" checks
(`button-name` from axe, `pf-icon-button-name`). You cannot honestly key an unnamed
element by name. A count increase is a regression. A named rule catches a swap that a
count cannot, but only when the two barriers key differently; one fixed and one newly broken
at the SAME collapsed identity leaves the count unchanged and is not caught. See the residual
section under Evidence floor.

Every basis can collapse several barriers onto one key, not just `count`. Two dialogs at
the same neutralized path share a structural key; two controls with the same accessible
name share a name key. So the floor records the observed barrier count for every entry and
the gate compares it for every basis: more than the floor accepted is `new`, equal or fewer
is `carried`. Fewer is never a regression. It is also not proof of progress: the same reading
comes from a page rendering fewer rows, which is why the surfaces report both counts and let
the operator say which happened.

#### Row keys

After the providers run, the check runner reads, on the same live page, the table row each
finding's element sits in (`Page.rowContext`). The finding's selector must name exactly one element.
A selector the page cannot parse, one that matches no element (the element left the page after the
scanner saw it), and one that matches more than one element are unreadable, and are handled like a
row that cannot be told apart, below. Only an element that was found, outside every body row of a
keyed table, keeps its old key with no gap. A finding with no selector at all is about the page or
the walk, not an element, and has no row. A preview draft (from an optional engine) is not read either: it never
blocks, so it gets no row key and no gap (section 7.7). A table is a `table` or an element with role
`table`, `grid`, or `treegrid`. Its rows are the `tr` and `role="row"` elements whose nearest table
is that table, so a row of a nested table is never one of the outer table's rows. Header and footer
rows (inside `thead` or `tfoot`, or holding a column header) are not body rows.

**Shadow roots, frames, and focus stops.** The row is read on the tree the element is drawn in. The
walk goes up from an element in a shadow root to its host, and up out of a same-origin frame to the
frame element, so a button in a web component, or in a frame, that sits in a keyed row belongs to
that row. Searches for rows and tables go down into every open shadow root and every same-origin
frame. axe names an element past a boundary with one selector per boundary, and its joined element
path names nothing, or more than one element, in the top document, so the axe provider keeps the
parts and the row read follows them: the host, then into its shadow root, or the frame, then into
its document. The element path stays as it was. A frame from another origin cannot be looked inside,
so a finding in one is unreadable. The keyboard walk reads the row of the element it focused at the
stop itself, through open shadow roots and same-origin frames, instead of going back through the
stop's path later: a stop whose path could not be computed has only a placeholder, which names
nothing. A step out of a shadow root or a frame is marked in the path from the row to the control,
so the path of an element in a web component never reads as one in the same light tree.

**Layout tables.** A `table` whose first role token is `presentation` or `none` is a layout table
and is not a table here. Its rows are not rows, so a data table inside a layout table is not nested
in an unkeyed row, and a control in a layout row looks for a row further up. A layout table whose
own rows carry a key source is still a table: rows a user can tell apart are a list, whatever the
role says, and leaving them out would key their controls the old way.

**How a table keys its rows.** The table's key source is the first of these that any of its body
rows has:

1. A key attribute: `data-row-key`, `data-key`, `data-id`, `data-ouia-component-id`, or `id`. An
   id a framework mints per mount (React `useId`, `pf-random-id-`, `OUIA-Generated-`) does not
   count.
2. A row header: a `th` that is not a column header, or `role="rowheader"`. Its text is the key.

A table none of whose body rows has any of these is not keyed, and its controls key as they did
before. In a keyed table, every body row must have the table's key source with a value no other row
of the table holds. Values are compared exactly, as they are hashed: the full string, with case and
spaces. A row's position is never used: rows move when a list is sorted or grows.

**How a table is named.** By its own key attribute (`id`, `data-ouia-component-id`,
`data-table-key`), else its accessible name in the order a browser uses (`aria-labelledby`, then
`aria-label`, then the caption), with white space collapsed, after the identity of the table and row
it is nested in, if any. Its position is never used. An unnamed table is fine when it is the only
table on the screen with its identity. Two tables whose names are the same once white space is
collapsed cannot be told apart. A name that holds live data, such as a count or a time ("Jobs (12)"
or "Updated 10:42"), changes between scans, so the table's rows key differently each time and their
barriers come and go: a baseline lists them as intermittent and floors none of them. Give such a
table a stable `id` or `data-table-key`.

A nested table's identity is valid only when the row and the table it sits in are valid. So a table
inside a row that cannot be told apart, inside a table that cannot be told apart, or inside a row
of a table that keys none of its rows, is ambiguous, and so is every row under it. It is never keyed
with an empty part in place of the identity it is missing.

**Rows that cannot be told apart.** A row in a keyed table that has no key of the table's kind, a
key another row of the table holds exactly, a key or a table identity over 65,536 characters, or a
table whose identity another table on the screen shares, is ambiguous. So is a row under an
ambiguous nested identity, a row whose hash another row of its table or another table on the screen
shares (see What is kept), a row the page could not be read for, and an element whose selector is
unreadable. Such a finding keeps its old key and is marked unverified, and the scan adds a
not-covered gap for the screen that names the screen and the rule, never a key, and says why and
what to change. Under the old key a new barrier in one row could fill a count accepted for another
and read as carried, so the run cannot prove it is not hiding there. Calling the finding new would
be a guess, so it is unverified: it blocks as not covered, never as carried. A finding outside any
body row of a keyed table is not ambiguous: it keeps the old key with no gap, as before.

**What is kept.** The row key and the table identity are page text, often customer data such as a
host or user name, and a nested table's identity includes the key of the row around it. Each is
hashed with SHA-256, exactly and in full, at once, and only the first 16 hex characters are kept,
in `evidence.extra.rowScope`. Hashing the exact value is what keeps two rows the page reader told
apart from sharing a hash; folding case or cutting a long key did not. Sixteen hex characters can
still collide, so the page reader also returns the keys of the table's other rows and the identities
of the screen's other tables, which are hashed and dropped at once. When a row's token matches
another row's, or its table's token matches another table's, the row is ambiguous. To bound what one
read carries, a table whose other keys and the screen's other table identities add up to more than
4 MiB is treated as too long to read. So no row key or table name
reaches a finding's identity or the committed floor. The rest of the row scope is the control's
role folded to a token and the tag and child-position path from the row down to the control. The
child positions are kept inside the row, so two unnamed buttons in one row stay apart, and they do
not depend on the row's position in the table. A finding's `elementPath` is the scanner's selector,
which tells a developer where the element is; it is not part of the identity and is printed only
through the scrubber.

The element key is `screenId|rule|row:` followed by the JSON encoding of those four values, so a
separator inside one cannot make two rows share a key. A row scope on a draft that is not four
strings is ignored, because a library caller can hand the gate any draft.

The row read runs in an isolated world, so page script cannot change the DOM reads a row key or a
table identity comes from (see Threat 10 in the threat model).

Declare `reachedWhen` on a screen with keyed tables. A row identity names no element a keyboard stop
or element path can meet, so a fixed row barrier is paid down only when the screen's readiness
signal held.

What row keys do not cover: a control outside any table row, a control in a table none of whose
rows has a key, a grid built without row roles, rows inside a closed shadow root, and a row in a
shadow tree that a light element is slotted into. A finding inside a frame from another origin is
a not-covered gap. Those keep the name, structural, or count key
and the residual described under Evidence floor.

#### Which keys a comparison uses

A floor is compared with the keys it was written with. `usabl baseline` writes version 3, with
row keys. A version 1 or 2 floor recorded a repeated control as one identity across rows, so the
gate compares it with the old keys: nothing reads as new or fixed only because the keys changed.
An empty floor has nothing to compare, so it takes row keys. `usabl floor prune` counts with the
same scheme as the floor it prunes. See the version rule under Evidence floor for the gap a
version 2 floor gets.

The built-in layer ids are stable (`axe`, `pf`, `walk`) so dedup and identity do not churn.
The field stays `string` so a later provider can add a layer without a gate change.

### Dedup

Collapse Drafts that share `rule` + identity across layers. Keep one Finding. Prefer
deterministic evidence, then the PatternFly why/fix when both axe and the rulepack fire on
the same control. Evidence class outranks layer because only deterministic evidence gates,
so a preview Draft must never be the survivor that represents a deterministic barrier.
Ranking by class first also makes the choice independent of the order Drafts arrived in.
The later tie-breaks (element path, layer name, and the rest of the Draft) compare UTF-16 code
units, never the machine's locale. A locale compare sorts "a" before "B", where code units put
"B" first, and it reads two spellings of one accented letter as equal, which would leave the
choice to arrival order. The tracked identities of the debt history are ordered the same way.

Only deterministic Drafts are counted against the floor, because only deterministic Drafts
are what `usabl baseline` counted when it wrote the floor.

### Evidence floor

`.usabl-evidence.json` is the accepted deterministic finding set for a surface. A code
owner writes it in an `approval_required` accept commit. Advisory findings are never
written to the floor. The accept loop converges: after the acceptance commit lands, the
next unchanged run sees the same floor and settles to `verified` (or `not_covered` only if
coverage cannot be re-established). Every count must be a safe whole number, and a floor whose
counts add up past the largest whole number a JavaScript number holds exactly is refused, because a
total past it depends on the order the counts are added in.

The count comparison runs in both directions, and both are gate decisions:

- **Above the recorded count** is new debt. More barriers at a known identity than the floor
  accepted is `new`, which gates: `regression` for a definite failure, `not_covered` for one
  usabl could not confirm. A brand new identity is `new` the same way.
- **Below the recorded count** is not a regression. The findings present stay `carried` and the
  verdict does not move. The run discloses the difference on the summary line, which gains a
  `N floor entries ahead of this run` clause, and on the terminal and the overlay, which both
  print the screen, the rule and both numbers under the recorded group. This is disclosure, not a coverage gap, because a gap
  makes a run `not_covered` by definition.

  The disclosure states the observation and never the cause. usabl counted two numbers and cannot
  tell a paid-down barrier from a page rendering fewer rows today, so it says both readings and
  leaves the operator to pick: if the barriers were fixed, `usabl floor prune` re-arms the floor to
  what is present; if the page simply shows less content today, nothing needs to change.

**Absent is a fix only with evidence the barrier's part of the page rendered.** A floored identity
is absent when this run has no deterministic draft at it. An advisory draft at the identity does not
make it present, because the floor counts deterministic barriers only; the gate, prune, and baseline
all read absence through one shared function. A floored barrier
missing from this run's drafts was either fixed or was on content that never rendered, and the two
leave the same absence. A screen in the cleanly scanned set had no gap, but that is not enough: a
screen whose header and navigation mount and whose content fails to mount has a real control to
walk and no provider error, so it has no gap, and every floored barrier in the missing content is
absent. That run used to report the barriers paid down. So the gate marks an absent floored
identity `fixed` only when one of these holds:

- the screen's readiness signal (`reachedWhen`) was declared and every declared part held, or
- the identity's own element was met this run: a keyboard stop or a draft on that screen whose
  neutralized path matches, for a structural identity, or whose slugged name matches, for a name
  identity. A counted identity names no element, so only the signal can confirm it. Neither
  does a row identity: its row and table are kept only as hashes, which no keyboard stop or
  element path carries, so an absent row is confirmed only by the signal.

The match is on the same reduced forms the keys are written in (`elementSlots` and
`identitySlot` in `src/primitives/identity.ts`), not on the identical element path. The
neutralized path replaces generated ids with placeholders and drops every `:nth-of-type()` and
`:nth-child()` position, so one button in a list confirms the floored path of another button in
the same list. The slugged name is lowercased with every run of characters other than `a` to
`z` and `0` to `9` folded to one hyphen, so names that differ only in case or punctuation match,
and a name written only in other scripts slugs to nothing and matches any other such name.

The limit to know: the readiness signal confirms every absent identity on its screen. When
`reachedWhen` matches only the app shell, such as a header or navigation that mounts while the
content fails to mount, the floored accessibility barriers in the missing content are marked `fixed`, and the
run can be verified. The accessibility barrier is not lost. Once its floor entry is pruned, or the debt
history confirms the fix and frees its slot, nothing carries it any more, so when the content
renders again it comes back as a new finding. It blocks a later change only when that change's
coverage reaches the screen, and that change may be one that did not touch the content. It never reads as a pass of that accessibility barrier for good. Point
`reachedWhen` at an element of the content itself, not the shell, so a screen whose content did
not mount never holds its signal.

A floor entry with count 0 accepts no accessibility barrier, so its absence pays nothing down: it
is never claimed `fixed`, it is not listed in `floorUnconfirmed`, and an accessibility barrier seen
there is `new`.

Otherwise the identity is not claimed `fixed`. It gets no finding, which is what a floor entry on a
screen the run did not scan already gets, so it is not paid down, it is not counted fixed in the
receipt, it is not reported as headroom, and the floor keeps its full count as debt. The verdict
does not change and no gap is raised. Instead the run shows a notice for each such screen. It names
the screen, the rules, and the number of barriers, and gives the fix, for example: "3 recorded
accessibility barriers on screen orders (button-name, link-name) were not seen in this run, so they are not
claimed fixed. If they are fixed, add a reachedWhen signal for this screen or run usabl floor prune
--unconfirmed." It never names an element key, because a key carries page text. The summary line
gains a `N recorded accessibility barriers not seen, not claimed fixed` clause that counts barriers, not entries,
and the notice itself is printed by the terminal, the pull request comment, the Stop hook (on a
verified stop too), the self-check, and the overlay. The text is written once, in
`src/output/floor-notice.ts`. The data is `floorUnconfirmed` on the gate output and on the Result,
one entry per screen.

Both tests are presence tests on sets, decided inside `gate()`, so they do not depend on order.
`run()` builds the evidence from the scans with `renderEvidenceOf`, and a caller of the exported
`gate()` that passes none gets the safe reading: no evidence, so no `fixed`. `usabl floor prune`
and `usabl baseline` read the same rule, `paydownConfirmed`, through `src/floor/unconfirmed.ts`.
Prune keeps such an entry by default and says so; `usabl floor prune --unconfirmed` removes it on
purpose and says how many it removed and why. Both read absence with the keys the floor was written
with, as the gate compares it, so a version 2 floor's collapsed row entries are not read as absent
while their barriers are on the page. Baseline, with or without `--partial`, carries such an entry
into the new floor at its recorded count and says so. It scans twice, and an entry either scan
could not confirm is carried; a carried identity is not recorded again or listed as intermittent. Two cases refuse instead, and write
nothing. If the floor being replaced is version 1 and a carried entry is a name or structural
entry, its count is a placeholder the run cannot replace with a real one, and writing it into a
current-version floor would present it as measured, so baseline exits 3, names the screens and rules, and
gives the two ways forward: a `reachedWhen` signal and a re-run, or `usabl floor prune
--unconfirmed` and then baseline. If the floor being replaced exists and does not parse, baseline
exits 4 before it scans, names the file and the reason without quoting it, and says to fix or
delete it first, because replacing it would lose its debt. `usabl doctor` names every screen that
holds floored debt and declares no `reachedWhen` signal.

**The blind spot, stated plainly.** A screen whose content fails to mount reads `verified` until it
declares a signal. With floored debt on it, the run shows the notice and claims nothing fixed. With
no floored debt, there is nothing to compare and nothing to say, the same as before this rule. A
notice is not a gap, so the verdict does not tell the two cases apart; the notice does. Declaring a
`reachedWhen` signal for content only that screen has is what turns a missing mount into a gap.

No change to the floor format was needed: the element is read off the identity key the floor
already stores. The cost falls on a genuinely fixed barrier the run cannot place. A counted barrier
(`button-name`, `pf-icon-button-name`) on a screen with no signal, and a fixed barrier on an element
the walk does not focus and no check reports, such as an image whose alternative text was added,
stay on the floor with the notice until the operator declares `reachedWhen` for content only that
screen has, or runs `usabl floor prune --unconfirmed` and reviews the diff. Measured on a real
Chromium scan of an axe-sourced floor: axe names a structural element with a short unique selector,
such as `tr>td>img` or `a[href$="#A-100"]`, which is not the path a keyboard stop records, so in
practice a structural axe entry is confirmed by a held signal, not by the walk. Name identities are
confirmed by a stop whose accessible name has the same slug.

What this still cannot catch. A path or a name that something else on the screen also has: another
element at the same path once the position numbers are removed, or a header button with the same
accessible name as the missing one. A signal that names the shell, which already lets a wrong page
through (section 8). Content that is missing and held no floored barrier, which leaves nothing to
compare.

### The residual hole, and why it is open

The recorded count is a high-water mark. `usabl baseline` writes it, `usabl floor prune` lowers it,
and nothing else moves the committed file. Between a pay-down and a prune the floor claims more
barriers at an identity than are present, and that difference is headroom. The debt history (see
the next section) closes most of that window without a human step: once two scans of main confirm
a fix, a run accepts only what they saw.

**A new barrier arriving at an identity with headroom is counted as `carried` until main confirms
the fix or `usabl floor prune` re-arms the floor.** It fills the slot the fixed barrier left, the tally stays
at or under what was accepted, and no comparison of counts can separate it from the debt that was
accepted. The same is true, without even the headroom, of a single change that fixes one barrier
and adds another at the same collapsed identity: the tally never moves at all. usabl discloses the
headroom on every run where it exists so an operator can re-arm, and it cannot disclose the
same-run swap because nothing about it is visible to a count.

usabl does not block on headroom, and that is a deliberate trade measured against a real
brownfield floor. Several collapsed identities on that application count icon buttons in table
rows, one entry standing at 15. The count therefore tracks how many rows the live application
renders, and a jobs list or a user list changes size on its own. Blocking on "below the recorded
count" would fail an unchanged codebase whenever a list came back one row shorter, the operator
would prune, and the next run with one more row would report a new barrier. A verdict that flaps
with row counts is worse than a disclosed hole, because a gate that cries wolf stops being read.

This is the price of collapsing several barriers onto one identity on pages whose content changes
size. Two things shrink it, and neither is a better count rule. **Strong element keys**: an
identity that keys each barrier separately never collapses and needs no count, so a name-basis or
count-basis identity is weaker here than a structural one, and a structural one is weaker than a
key that survives per element. **Prompt pruning**: headroom only exists between a pay-down and a
re-arm, so the window is as short as the operator makes it, which is why a run that observes one
says so and names the command. Headroom is not only left behind by a pay-down: a page that renders
fewer rows than the floor recorded opens the same window, and usabl reports it the same way
because it cannot tell the two apart.

Row keys (see Identity) are the strong element keys for the case that measured worst: a control
repeated in every table row. Each row's control is its own identity with a count of one, so a row
that is fixed or not shown today leaves headroom only at its own identity, and a barrier that
arrives in another row has an identity the floor never accepted and blocks as new. The proven case,
a floor of two, one fixed, a new one in another row, is a regression now. A row that the page does
not show today is reported as `fixed` and as headroom, and does not move the verdict, so a list
that comes back shorter does not flap, as long as nobody prunes it: `usabl floor prune` removes
an absent row, and that row then blocks as new when it returns, so prune after a real fix and not
after a short list. The residual stays open for every control that does not sit
in a keyed row, and for a barrier swapped in at the same row, control, and rule in one change.

`usabl baseline` scans the application twice, one scan after the other on the same tree, and
records only what both scans found. An identity both found is recorded at the smaller of its two
counts. Everything else is intermittent: a row the page showed in one scan only, or a tooltip the
scanner opened that was still fading out. Recording it would leave headroom on every run without
it, so it is left off the floor and listed in the baseline report by screen and rule, never by
element key, because a key can carry page text. An intermittent barrier is not accepted debt, so it
blocks as new on any later run where it appears. The report says so and names the ways out: fix
it, check the screen against fixed data, or waive the rule on that screen with an expiry. Coverage
must be complete in both scans; a partial baseline floors only the screens both scans saw cleanly.
The gaps the gate raises because the committed floor is old, the version 1 placeholder counts and
the version 1 or 2 floor that predates row keys, do not count against completeness here: they say
to regenerate the floor, and this is the command that does it. The gate hands those gaps to
baseline as a list of its own, and baseline drops exactly those. It never drops a gap for its ref or
its reason, because a check runner can return a gap whose ref is the floor file name. Every other
gap still counts.

The file carries a `version`. Version 1 wrote a placeholder count of 1 for every name and
structural entry, so those counts are not observations and the gate must not compare them.
Version 2 writes the observed count for every entry. Reading a version 1 floor that holds
name or structural entries produces a coverage gap, so the run reports `not_covered`
instead of a green it cannot support. Version 3 also keys controls in keyed table rows per row.
A version 1 or 2 floor is compared with its own keys, and when this run found barriers in keyed rows
on a screen the floor holds entries for, the gate adds a coverage gap: the floor recorded those
controls as one identity across rows, so a barrier fixed in one row and a new one in another leave
its count unchanged, and the run cannot prove no new barrier is hiding. The run reports
`not_covered` until `usabl baseline` regenerates the floor at version 3 and the diff is merged. A
version 1 or 2 floor with no barrier in a keyed row on its screens gets no gap. A version 1 or 2
floor that holds a row entry is refused, because no baseline wrote one. Waivers scoped to one
element key name the old key, so a waiver for a control in a keyed row must be rewritten with the
row key after the floor moves to version 3; until then the finding is not waived and blocks.
Both floor disclosures are decided inside `gate()`, not in the run path, because `gate()` is
exported and CI, the overlay and the page helper reach it directly. A check that lived only in
`run()` made the verdict depend on which door the caller came through. The gate weighs its own
gaps and names them in its summary; `run()` appends them to the Result's coverage so the gaps a
reader sees are the gaps the verdict was reached from.

Two floor entries may not share an identity (the same `screenId`, `rule`, and `elementKey`; the
layer is not part of it). The gate indexes the floor by that identity, so a second entry would
replace the first, and which one survived would decide whether a barrier reads as new or carried.
The floor is refused instead, with both entries named by position and never by key, because a key
carries page text. One parser reads the floor everywhere: in `usabl check`, in `usabl floor
prune`, in `usabl doctor`, and, again, inside `gate()` on the floor it is handed, so a library
caller that builds a floor by hand gets every check the file gets: the version, each entry's
fields and count, the screen id grammar, and the duplicate check. A refusal is an
`InputRefusedError` naming the field, for example `floor.entries[1]`.

`gate()` checks every other input it reads the same way, because a field of the wrong type is
read in a way that looks like a pass. A `nothingToCheck` of "false" is truthy and read as idle,
an `evidenceClass` of "Deterministic" never gates, and a `gaps` value with no length reads as no
gaps. So the gate reads each input field once, checks what it read, and decides the verdict from
that checked copy only. A getter that returned one value to the check and another to the gate
would otherwise put an unchecked value in the verdict. What it checks:

- `coverage` and every draft against the Result contract, with the reader `usabl comment`
  uses: `nothingToCheck` is a boolean, every list is a list, every closed set holds one of its
  values (evidence class, confidence, severity, gap state, provenance, profile), every text
  field is a string, and a draft's evidence has the shape the contract gives it. A layer only has
  to be a string, because the contract leaves layers open.
- The floor with the floor parser, and every waiver with the waiver parser the ledger file goes
  through, so a waiver's `created` and `expires` must be ISO-8601 UTC. The gate compares
  `expires` with its clock as text, which is only a date comparison in that format.
- `guardDivergedPaths` is a list of strings, and `now` is an ISO-8601 UTC timestamp.
- `cleanlyScannedScreens` is a real `Set`. Its members are read through `Set`'s own iterator
  and copied into a new set, and only that copy decides which floored identities may be marked
  `fixed`, so an object or a subclass that answers `has` for screens it does not hold cannot
  mark a barrier fixed on a screen nobody scanned.
- Every screen and surface id against the id grammar, as above.

### Debt history: a confirmed fix closes its slot

The floor's count is a high-water mark, so a fixed barrier used to leave headroom that a new
barrier could take, and read as carried, until someone ran `usabl floor prune`. The debt history
closes that slot on its own. It only ever lowers the debt a run accepts, which makes the gate
stricter, so a missing or wrong history falls back to the floor alone and cannot produce a green
the floor would not. The code is in `src/history/`.

**Where it lives.** A branch in the team's own repository, `usabl/history`, holding append-only
JSON Lines files, one per month (`2026-10.jsonl`). Only the default-branch workflow that `usabl
install --ci` writes appends to it, after a scan of main. Its `history-scan` job runs `usabl history
record`, which scans every screen, the way baseline does, and writes one record to a file. Its
`history-append` job, which runs no application code, runs `usabl history append`, which commits the
record on top of the fetched branch with git plumbing, and the job pushes without force. No server
and no telemetry. A run reads the branch as git objects at `origin/usabl/history`, never from a
working tree, so a pull request cannot write its own history. The gate job already checks out with
`fetch-depth: 0`, which fetches every branch, so pull requests need no new step.

**What a record holds.** The schema version, the time, the commit, the receipt bindings of the
scan (source tree, policy hash, runner version, scanner versions), the hash of the floor it was
compared with, and per screen its coverage: `full` when every scan of the screen had no gap,
`partial` otherwise. For each floored identity on a full screen it holds the first 16 hex
characters of the SHA-256 of the identity key, the rule, the basis, and the observed count. A
count at or above the floor's count is recorded as seen. A count below it needs evidence that the
identity's part of the page rendered; otherwise the record holds no observation for it. An absent
identity is recorded as zero only when the gate's own rule (`paydownConfirmed`) shows that. A
nonzero count below the floor's is recorded only when the screen's readiness signal held: the
barriers the scan drew are themselves elements at the identity, so seeing them does not show that
the rest of the content rendered. Without this, a screen whose header mounted and whose content did
not would record a lower count, two such scans would release debt that was never fixed, and the
next pull request that renders everything would block as a regression. No element key and no page
text. The parser refuses any field it does not know, so a record cannot carry text the writer
did not put there.

**Confirmed fixed.** Two consecutive observations of an identity, each from a full scan of main and
each written against the same floor, below its accepted count. The accepted count then becomes the
higher of the two, so a page that shows either reading again is not a regression. A scan that holds
no observation of the identity (the screen was partial, or its count was below the floor's with no
render evidence) is skipped. It neither confirms nor breaks the pair. A further pair below the new count
lowers it again.

**Intermittent.** Two observations of one identity on the same source tree with different counts.
The code did not change and the reading did, so the barrier comes and goes with the page content.
It gets its full floor count back, is labelled intermittent, and is never released again under this
floor. This covers a confirmed fix that reappears on an unchanged tree, and a row that shows in one
scan of main and not the next. Each identity is judged on its own, so a row identity is judged by
its own row and never by how many rows the table showed. A fix that comes back after the code
changed stays closed, because that is a regression. Unrelated pull requests are not affected
either way: they do not scan the screen.

**How a run is judged.** Against the effective floor: the floor as committed (read from the trusted
ref in CI), with each identity lowered by the fixes confirmed in records written at the base commit
or one of its ancestors. A record on a commit the base does not contain, for example one from a
newer main, does not apply. Only records with the same floor hash count toward a release or an
intermittent label, because a floor written again by `usabl baseline` or `usabl floor prune` is a
new acceptance by a person and starts a new history. The effective floor has the floor's version
and scope, never an identity the floor lacks, and never a count above the floor's. An identity whose
accepted count reaches zero is left out, so a barrier that returns there is new. `run()` builds it
with `loadDebtTracking` and hands it to `gate()` in place of the committed floor; the gate itself is
unchanged. Only a version 3 floor is tracked. A version 1 or 2 floor counts the rows of a table
together, so an observation cannot say which row was fixed, and the gate already asks for a new
baseline when such a floor meets a keyed row.

**Missing or unreadable history.** No history reader (a library call), no branch, a branch usabl
cannot read, a floor before version 3, or a base commit usabl cannot resolve: the run is judged
against the floor as committed, exactly as a run without history, and `Result.debt` says tracking is
off and why (`no-reader`, `no-history`, `unreadable`, `old-floor`, `no-base`). A history with one
line usabl cannot read is unreadable as a whole, because skipping the line could skip the
observation that keeps two absences from being consecutive. The reason names the file, the line,
and the field, never the value.

**Why it cannot make a run greener.** The history only lowers counts on floor identities. A lower
count can turn a carried finding into a new one, and can take away a `fixed` finding, a headroom
line, or an unconfirmed notice. It cannot add a carried finding, and it cannot remove a gap,
because a version 3 floor raises neither of the floor gaps. A forged history that claims higher
counts stops a release and nothing more; one that names identities the floor does not hold is
ignored. A forged history can still lower counts and block pull requests. Protecting the branch
with a ruleset (no force push, no deletion, updates only from the default-branch job) is the
hardening for that, and it is optional.

**Determinism.** The fold is pure over the floor and the records in append order, and ages count
whole days from the run's clock, so the same tree, floor, history, and date give the same verdict.

**What a run reports.** `Result.debt` carries the counts: barriers the floor accepts, barriers this
run accepted, fixes main confirmed, barriers this run did not see (counted as fixed in this change
until main confirms them), what remains, the age in days of the oldest remaining barrier, and how
many are intermittent. The pull request comment prints them as one line, and `usabl debt` lists the
remaining debt by screen and rule (section 11.4).

**What this still cannot catch.** Between a fix landing and its second confirming scan, the slot is
still open, as it was before. A barrier swapped in at the same collapsed identity in the same change
never moves a count. A history that starts with two absences of a floored row on an unchanged tree
releases the row, and a pull request that shows the row before the next scan of main blocks once;
that scan then marks it intermittent. First-seen dates start with the history, so debt older than
the first record shows the first record's date. An identity hash of a short name can be guessed by
someone who can read the branch, but such a reader can already read the floor, which holds the key
itself.

### The ledger: how long accessibility barriers stay open

`usabl debt ledger` lists every identity that was ever in the evidence floor on the trusted branch:
when it was first seen, whether it is open, fixed, left the floor, or reopened, and how many days
it was or has been open, with the way each number can be wrong. It is measurement only. It scans
nothing, mints no verdict and no receipt, never blocks, and writes a file only when `--out` names
one. No verdict path loads it: the gate, the run, the stop hook, the CI enforce step, and
`checkPage` are checked by a test that walks their imports and fails if any of them, or the
overlay host, reaches `src/cli.ts`. The CLI, which CI runs for `check` and `enforce`, loads the
ledger only by a dynamic import inside the `debt ledger` command, and the same test fails if a
static import comes back. The code is `src/history/ledger.ts` (the pure builder), `ledger-git.ts`
(the two readers), and `ledger-report.ts` (the command).

**Sources, in this order of trust.** First, the floor file's own history on the trusted branch:
every commit on the first-parent line of `--trusted-ref` (default `HEAD`) that changed
`.usabl-evidence.json`, read as committed objects. A merged branch counts at its merge commit. The
commit where an identity enters the floor opens a span, and the commit where it leaves ends it.
Second, the debt history at `origin/usabl/history`: records that confirm a floored accessibility
barrier fixed, and records that show it seen again. History records are replayed in the order of
the commits they scanned on the first-parent line, never in the order they were appended. Receipts
are not a source, because a receipt holds counts and no identities. Nothing is read from the
working tree. On `HEAD` of a feature branch, the floor history includes that branch's own floor
commits.

**One row per identity.** The identity is the one the floor keys on: screen, rule, and element
key, row scope included. A row holds the screen, the rule, the element key as the floor stores it,
first seen (commit and committer date), state, last change (commit and date), its open spans, days
open, the two bounds below with their reasons, and the last full scan of main that saw it.

- **Fixed.** Only the history shows a fix: two consecutive full scans of main, written against the
  same floor, that both see no accessibility barrier at the identity. The fix is dated at the
  second scan's commit. A scan with a gap on the screen is skipped and neither confirms nor breaks
  the pair. A scan that still sees some accessibility barriers there keeps the row open. A record
  the ledger cannot place in time blocks a fix for every identity it observes, because it may sit
  between the two scans.
- **Left the floor.** An identity that leaves the floor with no such pair of scans before it. A
  fix, a floor reset, a re-baseline, a prune, a renamed screen, and a changed accessible name all
  look the same here, and usabl cannot tell them apart without the history. Both bounds are set.
- **Reopened.** An identity that closed, by a fix or by leaving the floor, and came back: a later
  scan sees it after a fix, or a later floor holds it again. It is one row with every span listed
  and days open as the sum of the spans. The text follows how the last span ended: "reopened, open
  now", "reopened, fixed again" (a fix the history showed), "reopened, left the floor again", or
  "reopened, open until a gap".
- **Intermittent.** Two scans of the same source tree that see different counts show the
  accessibility barrier comes and goes with the page content. The ledger then withdraws every fix
  the history confirmed on that row, whether or not the row reopened since, and labels the row
  intermittent. A withdrawn span ends where the floor alone says it ends. Debt tracking never
  releases such an identity again either.

**Which way a number can be wrong.** Every row carries two facts, each with its reasons.

- `mayBeMore`: the true number could be larger. The row was already in the floor the first time
  its screen was floored (the first baseline, a screen floored for the first time, or a partial
  floor that was widened), it was in the oldest floor a shallow clone holds, it entered or ended at
  a gap in the floor history, it left the floor, or commit dates go backwards along it.
- `mayBeLess`: the true number could be smaller. There is no usable history for it (no history, an
  unreadable one, or a history hash it shares with another identity), the history is on but no
  full scan of main saw it during one of its spans, a record that touches it could not be placed
  in time, it left the floor, or commit dates go backwards along it.

The table prints "N days" when neither holds, "at least N" for `mayBeMore` only, "at most N" for
`mayBeLess` only, and "not known (N by the floor)" for both. N is always the sum of the spans. The
floor is accepted debt, not proof that an accessibility barrier is still on the page, so a span no
scan saw is never called a lower bound. A row still open also shows the date of the last scan that
saw it, when one did.

**First seen is the earliest evidence.** It is never presented as the day an accessibility
barrier was introduced. One in the first floor ever committed shows that commit's date, and the row
says "seen at the first baseline; may be older".

**Dates and days.** Committer dates in UTC. A committer date marks when a commit was made, not when
it reached the branch. A span counts whole days, the floor of elapsed hours over 24, and days open
is the sum of the spans, so a reopened row can lose up to a day per span. An open span ends at the
committer date of the commit the trusted ref names, and the output names that commit and its
date. The command reads no clock, so the same repository state gives byte-identical output, and an
old ref counts to its own date. When a later commit on the line is dated before an earlier one, the
row says that commit dates are out of order, a span that would be negative counts as 0 days, and
both bounds are set. Nothing is clamped silently.

**When history is incomplete.** The ledger names the rows a gap touches and why, never fills it
with a guess, and never drops a row.

- A shallow clone (`git rev-parse --is-shallow-repository`): rows in the oldest floor the clone
  holds may be older.
- A floor rewritten to a new version: an identity that leaves the floor there is not called fixed
  or left. Its row is "open until a gap", counted to that commit, and it may have stayed open after.
  An identity that enters there may be older under an earlier key.
- A floor that could not be read at a commit, or a floor file that was deleted: the same rules,
  counted from that commit.
- A missing or unreadable history branch: every row says a fix main confirmed would not show, and
  so may be smaller. An empty ledger says the history is missing too.
- A history record whose commit the ledger cannot place on the first-parent line: it is not used,
  it blocks fixes for what it observes, and the rows it touches say so.

**Limits.** Each floor version is cut to its version, its scope, and its identities as it is
read, and an identity held by many floors is one shared object. When the floor history holds more
than 2,000,000 floor entries across its floor commits, or one git read prints more than 256 MiB,
the command says the limit, says it did not run, and says to name a narrower ref with
`--trusted-ref`, or to run it in a full clone if the clone is shallow. The git readers pin their
output against the person's git config: `--no-show-signature`, `--no-color`, `--no-decorate`,
`log.follow=false`, replace refs off, and a format of commit ids and epoch seconds only.

**Output.** The terminal view is a table sorted by days open, longest first, then a totals line
with the number of open, fixed, left the floor, and reopened rows. The median and the longest of
each are taken over the rows where neither bound holds, the line says how many those are, and with
none there is no median. `--json` prints the full ledger and `--out <file>` writes it to a file.
Every string printed, in the table and in the JSON, goes through the published scrub first,
because an element key, a screen id, or a rule can carry page-derived text. The ledger makes no
claim about how fast a team fixes things and no claim about compliance. No result on a real
repository is claimed here: the hand count in `test/history/ledger-git.test.ts` is a scripted
history.

**Exit codes.** 0 when it ran. 2 when no commit on the trusted ref ever held a floor. 4 when the
folder is not in a git repository, the ref does not resolve, git cannot read the history, the
history is larger than the limits, or the ledger's own check finds spans that overlap or count more
days than have passed since first seen (a bug, so it prints no numbers).

### Failure taxonomy

- No UI-touching files: nothing to check (`verdict: null`, exit 0). Not `not_covered`.
- UI files changed that do not map to a screen: `not_covered`.
- A screen fails to load or CDP disconnects: `not_covered` with reason.
- A change edits rules, config, evidence, or waivers: `approval_required`.
- A scanner version cannot be read: `not_covered`.
- Any unhandled error: fail open with disclosure, never silent.

---

## 10. Guard and trust model

Two-tier, honestly scoped.

### Local (tamper-evident)

The trust anchor is git HEAD. Every guarded path must exactly match its committed
content. A divergence forces `approval_required`. This is tamper-evident, not
tamper-proof: an agent with shell access can edit and commit anything. The guard
catches the change and refuses to issue a trusted verdict, but it cannot prevent the
edit.

### CI (trusted-ref policy read)

CI requires `--trusted-ref` (a forge-supplied base revision). Config, evidence,
waivers, and rules are read via `git show <ref>:<path>` from the trusted base, never
from the PR working tree. Combined with CODEOWNERS + branch protection (when the host allows it), a PR author
cannot influence what policy they are judged against.

`usabl enforce policy` lists the PR head and the trusted ref once each, with `-z`, and selects
the guarded files with the same matcher the local guard uses (see "Guarded path matching"). For
each guarded file that differs, the owners come from the last `CODEOWNERS` rule that matches it.
The check refuses a path no rule matches, a path whose last rule names no owner, and a path whose
last rule names an org team or an email, because usabl cannot resolve team membership or match
an email to a login. It refuses the whole file on a pattern it cannot parse (`**`, `!`, `[ ]`,
`\`, or a wildcard before the last segment), on an owner that is not a `@user`, an `@org/team`, or
an email, and on a `#` inside a pattern or owner (one that does not follow whitespace), because
GitHub may read such a line another way, so the last match is unknown. A `#` at the start of a
line or after whitespace starts a comment. A team or email line that is not the last match for a
changed guarded path does not block. Every other path needs an approval of the current head from
one of its users who is not the author. `usabl doctor` reports the same limits in the same words
under policy scope.

For the forms GitHub's CODEOWNERS documentation shows, a pattern matches the way the
documentation says, and a test holds every documented example usabl supports. A leading slash
anchors at the root, a slash-free pattern matches at any depth, and a trailing slash owns
everything under the folder. A wildcard in the last segment of a pattern with a slash does not
match through a parent folder: `docs/*` matches `docs/a.md` and not `docs/b/c.md`. A form the
documentation does not show is read every way it could be read, and the check refuses a path when
those readings disagree for it and that rule could be its last match. The open readings are: a
pattern with an inner slash and no leading slash (`src/gate/`) may anchor at the root or not; a
slash-free pattern with no trailing slash, a name (`gate`) or a wildcard (`*.js`), may or may not
own a folder whose name it matches, such as `src/lib.js/`; and `?` may be a wildcard or a literal.
The refusal names the pattern. Doctor reads a present workflow file whose last match is unknown as
unknown. The policy check and doctor read each line with one line reader.

### Guarded path matching

Every `guardedPaths` entry is first read in one canonical form, the form git prints a path in. A
leading `./` and every `.` segment are dropped, repeated `/` are collapsed, a trailing `/` is
dropped, a `..` segment takes away the segment before it, and `.` alone is the whole tree. So
`./src/gate/`, `src/gate//`, and `src/gate` guard the same files. Every later step reads that
form. Nothing compares the raw entry text with git output.

A brace group is expanded before anything else, as Node's glob does, and each expansion is put
through the canonical form and the matcher on its own. So a `.` or `..` inside a brace alternative
is read as the path it names: `{.,b}/y.json` guards `y.json` and `b/y.json`, and
`{policy,b/..}/rules.json` guards `policy/rules.json` and `rules.json`.

The guard never throws because of what an entry says, and never guards less because it cannot
read one. An expansion in a form the matcher cannot evaluate the way Node's glob does is read wide:
a brace range such as `{1..3}` or `{a..c}`, `?`, `[ ]`, `( )`, a `\` escape, or a nested or
unbalanced brace guards the literal folder above the first segment the matcher cannot evaluate, so
`policy/rule{1..3}.json` guards `policy/`. An expansion with no such folder guards the whole tree:
one that starts with `/`, one with a `..` that leaves the root, and one with a `..` anywhere after
a wildcard, since a wildcard can stand for any number of folders and a later `..` can climb above
any of them, so `policy/*/../../x.json` guards the whole tree. The same reading is used at the
trusted ref, at HEAD, and on the working tree, so a change there needs a code owner's approval,
and the pull request that repairs the entry can merge with one. `usabl enforce policy` names each
entry read this way, in every outcome, and says how to write it; `usabl doctor` does too. A local
run has no field for that sentence, so its Result names only the changed files.

Config load refuses every form the guard can only read wide, so a new config never holds one. It
refuses the glob forms above in every glob list and says to list the alternatives of a range with
commas. In `guardedPaths` it also refuses an entry that starts with `/` (and shows the same path
without it), one with a `..` that leaves the root, one with a `..` after a wildcard, and one with a
`.` or `..` segment inside a brace alternative, and says how to write each. Entries that loaded and
worked before still load and read in canonical form: `./src/gate/`, `src/gate//`, `.`, and
`a/../b` outside braces and before any wildcard. An older config, or a trusted ref's config, can
hold a refused form, and the guard reads it wide as above. An empty entry is the whole tree.

The `requirements` value names a folder, and the requirements loader accepts any folder name, such
as `requirements (v2)`. The guard reads it, and the always-guarded ledgers, as literal paths: no
glob rule applies to them. A `guardedPaths` entry with the same text as `requirements` is read both
ways, as that path and as a glob, and the guard guards what either reading matches, so
`requirements: "policy/*"` with `guardedPaths: ["policy/*"]` guards `policy/rule1.json`.

Config load refuses a `guardedPaths` entry with white space at the start or end, and shows the
entry in quotes. The limit that remains: an entry that is a valid path but names nothing, such as
a typo, a wrong letter case, or a look-alike letter, guards nothing, in CI and locally. `usabl
doctor` is where it shows: it reports a literal entry that matches no file in the last commit as
guarding nothing today.

One matcher selects the guarded files from a list of paths. A literal entry matches itself and
every file under it, as a folder; the whole tree matches every file. A glob entry (one that holds
`*` or a brace group) matches the files it names and every file under a folder it names, with
Node's dot rule: a wildcard does not match a name that starts with a dot, as `fs.glob` does. A dot
written in the pattern still matches. So a dot-named file under a glob entry, such as
`policy/.override.json` under `policy/*.json`, is not guarded, locally or in CI. Under a literal
entry a dot-named file is guarded, because git lists it.

The two places select from different lists:

- `usabl enforce policy` lists the trusted ref and the PR head once each with
  `git ls-tree -r -z`, and the matcher selects from those two listings. It reads no working tree.
- The local guard lists the trusted ref and HEAD the same way and selects with the same matcher.
  It then adds, as found, what `fs.glob` finds on the working tree for each entry and for
  everything under it. That adds files on disk that no commit holds, such as a new untracked file
  under a guarded folder. The HEAD listing holds a file deleted locally, so that file is still
  compared.

For each glob form config load accepts (`*`, `**`, `{a,b}`, a comma-less brace read as text, and
mixes of them), a test shows that the matcher on a git listing selects the same files `fs.glob`
selects on the working tree. For a literal folder the matcher also selects the dot-named files
under it, which `fs.glob` skips.

A literal entry that matches nothing is compared as its own canonical path, so a guarded file
absent everywhere is still checked. A glob entry is never compared as a path, and neither is the
whole tree. A glob entry that starts with a wildcard, such as `**/x.json`, lists the whole tree at
each ref. If that listing passes the read limit, the run stops with no verdict and says to start
the entry with a folder name. For a clean tree in a repository whose names are plain ASCII, the
policy hash in a receipt is the same as before this matcher.

### Config-guards-itself

Check the config file's own integrity against the anchor before trusting its contents
to build the guarded set. Four policy files are always forced into the guarded set
regardless of what config says: `usabl.config.json`, `.usabl-evidence.json`,
`.usabl-waivers.json`, and `usabl.routes.json` (`ALWAYS_GUARDED` in `src/trust/guard.ts`);
the requirements directory is added when config sets `requirements`. Ordering is
load-bearing: integrity check before reading contents.

### Session pinning

At session start, record sha256 pins of every guarded path keyed by session id and
repository, stored outside the repo in the OS temp dir. The repository key is derived
from the resolved working directory the hook runs in, so pins recorded in one repository
are never compared against another. The stop hook checks pins mid-session to catch a
committed tamper that git-status-clean cannot see.

The temp dir is shared by every local user, so pins are kept private to the user:

- They live in one directory per user. When `$XDG_RUNTIME_DIR` is set, is absolute, and
  passes the checks below, that is `usabl-pins` inside it. On Linux with systemd this is
  `/run/user/<uid>`, which the system creates at login for that user alone. Otherwise it
  is `usabl-pins-<uid>` under the temp dir. Some hosts set `$XDG_RUNTIME_DIR` to a
  directory that fails the checks, such as one owned by root with mode 0755; the temp
  dir is then used.
- The pin directory is created with mode 0700. Before any read or write it is checked
  with `lstat`: it must be a real directory, not a symlink, owned by this user, with no
  permission bits for group or others.
- A pin file, `<session id>-<repository key>.json`, is opened with `O_NOFOLLOW` after an
  `lstat` check, so a symlink at the path is refused, never followed. The open handle is
  then checked with `fstat`: a regular file, owned by this user, with no permission bits
  for group or others.
- A pin file is never changed in place. New pins are written to a temp file in the same
  directory, created exclusively (`O_CREAT` with `O_EXCL`, plus `O_NOFOLLOW`) with mode
  0600. That file is then renamed over the pin file, or for the first pins of a session
  linked to the pin file name, which fails if anything is already there. A process killed
  part way leaves the old pins whole, never an empty file.

Any failed check refuses with a plain reason and a fix, and writes nothing. A pin file of
ours that does not parse is refused the same way: it is never read as "no pins yet",
because recording fresh pins over it would take whatever is committed now, a tamper
included, as the baseline. The stop then goes on without the drift comparison. It does
not block, because a block would trap the session behind a file another user may
control; this is the same fail-open choice as the exit 4 decision in the threat model.
It is never silent. The decision line carries a note, for example `VERIFIED (exit 0,
session drift not checked): ...`, and stderr ends with a notice: `NOT verified - usabl did
not use session pins for this stop because the pin store refused to read them ... To fix:
see "pin fix" in the untrusted text below.`, then an untrusted frame with `pin reason:` and
`pin fix:`. The reason and fix name directories and files from the environment, so they are
carried values and are printed only inside the frame. The same note and notice appear when
the hook input has no session id, or one usabl cannot use as a file name; that id is printed
only inside the frame too.

Drift blocks with `NOT verified - guarded policy drift during this session: N guarded file(s)
changed ...`, a next step, and the paths under `drifted files:` inside the frame, because a
file name under a guarded directory is chosen by whoever adds the file. A hook error prints
fixed text outside the frame and the error message inside it.

What this does not cover:

- Pins are best-effort against an agent with a shell. Deleting the pin file, as the same
  user, resets the session baseline with no message: the next stop records new pins
  from what is committed then. Any process running as the user can do that, so pins
  catch a committed tamper only from an agent that does not also remove the pins.
- Where the temp dir is used, another local user can deny the drift check by creating
  `usabl-pins-<uid>` first. The check is then skipped on every stop, loudly. Under
  `$XDG_RUNTIME_DIR` on systemd Linux this denial goes away, because no other user can
  create anything in that directory.
- On Windows the platform reports no user id, so the directory has no id in its name and
  the owner and mode checks are skipped. Windows reports modes such as 0o666 that say
  nothing about who can read a file. The per-user temp dir Windows gives each account is
  what keeps it private.
- The checks assume the temp dir only lets an entry's owner remove or rename it, which
  the sticky bit on `/tmp` provides.

### Receipt binding

Five bindings are compared on re-verification, plus the waiver end below:
- `sourceTree`: hash of the working tree (git write-tree on a temporary index), read before the
  run plans. The run reads it again after the scan and every policy read, before the gate. If
  the two reads differ, a file changed during the check: the run carries a not-covered gap
  (ref `working tree`), is never verified, and mints no receipt. The receipt binds the first
  read, so an edit after the second read moves the tree away from it. An idle run is left idle.
  Every run reads the tree first, so a repository with no commits, where git has no HEAD to read
  the tree against, ends with no verdict and exit 4, and the summary says to make a first commit.
  Known limits: two reads see the tree only at those two moments. An edit made during the scan
  and undone before the second read leaves the reads equal, so the run is verified and the
  receipt binds a tree the scan did not see as it was. A dev server that still serves an older
  build than the tree is scanned, and the receipt binds the newer tree. Both stay verified today.
- `policyHash`: sha256 over sorted guarded-path blob shas at the anchor.
- `runnerVersion`: package version + sha256 over the engine's own shipped files
  (first-party `dist/*.js` in the installed package, or the `src` tree when run from
  source). A change to any shipped engine file moves this hash, so a receipt minted by
  one engine build cannot re-verify under a tampered or upgraded engine.
- `scannerVersions`: the axe-core, Playwright, and Chromium versions the run scanned with.
  `verifyReceipt` compares these too, so a swapped or upgraded scanner
  invalidates the receipt. The package versions come from each package's `package.json`.
  The Chromium version is that of Playwright's headless shell (`chrome-headless-shell`),
  because a run launches Chromium headless with no channel and Playwright starts the headless
  shell for that, not the full browser `chromium.executablePath()` names. usabl finds the
  headless shell in the full browser's browsers folder, at the revision the
  `chromium-headless-shell` entry names in the `browsers.json` of the installed `playwright-core`
  package, with Playwright's layout. It checks the file exists and binds what it prints for
  `--version` (for example `151.0.7922.34`). This holds for Playwright's download and a custom
  `PLAYWRIGHT_BROWSERS_PATH`. The revision never comes from the full browser's folder name, and
  no other shell folder on disk is used. When the headless shell prints none, it is the revision
  in the name of its folder (`revision-1234` from `chromium_headless_shell-1234`), a form no real
  version has. When the list cannot be read, names no single revision, or gives the entry a
  per-platform override, or the shell's folder is missing, or neither read gives a value, the
  version is `unknown`; the full browser's version is never bound in its place. Such a run carries a not-covered gap (ref `scanner versions`) that names the fix,
  mints no receipt, and `usabl doctor` reports the browser as drifted with the same fix. An
  unreadable version never matches on verify, on either side.
  When an optional commercial engine is on, `scannerVersions.engines` maps its id to the
  installed package version, and `verifyReceipt` compares that map too: a version change,
  or an engine turned on or off, invalidates the receipt. An absent map and an empty one
  both mean no engine (section 7.7).

- `historyHead`: the commit of the debt history branch the run read, or null. The history can
  lower the debt a run accepts, so a receipt minted before the history moved stops matching,
  and the Stop hook's fast path falls back to a full run. Added in receipt schema version 2. A
  stored version 1 receipt is not read, which costs one full run.
- `waiverExpiresAt`: the earliest expiry among the waivers the run applied, or null when it
  applied none. A waiver applied when it was live at the run's clock and matched a finding the
  gate marked waived. Once the injected clock reaches this time the gate counts the waived
  accessibility barrier again, so `verifyReceipt` fails the receipt and the Stop hook's fast
  path runs a full check from that moment, and not before. The receipt finds the waivers it
  binds with the gate's own match rule (`waiverMatchesFinding`), so there is one rule. If a
  waived finding still matches no live waiver, the earliest live waiver is bound instead, which
  can only bind an earlier time. A receipt that counts a waived finding but
  binds no time, or binds a value that is not an ISO-8601 UTC time, does not verify. A receipt
  minted before this field existed has none; it verifies only when it counted no waived finding.
  The schema version stays 2, because that absent value is read safely.

A source-tree change or committed policy change invalidates the receipt, and so does an
engine or scanner change, a move of the history branch, or the end of a waiver it applied.

Scope and limits, stated plainly so the proof is not oversold:
- The engine hash covers first-party engine code, not the `node_modules` dependency
  bytes. Dependency identity is bound by version through `scannerVersions`, not by a
  content hash; folding a lockfile content-hash into the fingerprint is a planned
  follow-up.
- The hash keys on relative paths normalized to `/`, so it is identical across
  operating systems. Mint and verify must use the same deployment shape: a receipt
  minted from a source run and one minted from the built package carry different engine
  hashes for the same version.
- The binding fingerprints on-disk bytes, not the bytes Node ultimately executes
  (`NODE_OPTIONS`, loaders, and module redirection can still alter runtime behavior).
  It is defense-in-depth that complements the root-owned read-only engine mount and the
  trusted-ref pin; it is not a standalone cryptographic proof that a specific engine ran.

### CODEOWNERS + branch protection

Every guarded path and the CI workflow require code-owner review before merge under
branch protection. Whether admins can bypass depends on the ruleset's bypass list.
This is the single highest-value security item. On this repository the `usabl-required`
check is required by the main-branch ruleset.

---

## 11. Surfaces

Every surface calls the same CLI core (`usabl check` or equivalent library export).
Surfaces differ only in **when** they run, **who** sees the output, and **whether**
they enforce. See the bloat-proof rule in section 3.

### 11.1 CLI (foundation)

The canonical entry point. Runs coverage → providers → gate → `Result`. Prints or
exits with `exitCode`. Everything else is a wrapper.

**Why it exists.** Brownfield adoption: a team can run `usabl check` against an
existing PatternFly app the same way they would run axe or Lighthouse - get findings,
establish an evidence floor, then turn on the stop hook and CI. It is scanner-shaped
invocation, not scanner semantics: output is a full `Result` with verdict, differential,
coverage honesty, and optional receipt minting.

**Command surface.** `main` recognizes these commands: `check`, `brief`, `comment`, `bypass`,
`init`, `baseline`, `floor`, `drift`, `enforce`, `install`, `stop-hook`, `doctor`, `docs`,
`session`, `debt` (with its `ledger` subcommand), `history`, `serve-build`, `extract-build`,
`verify`, `import`, and `help`. `check` is the default
when no command is given, so `usabl` alone runs a check. `usabl --help`, `usabl -h`, `usabl help`, `usabl <command> --help`, and
`usabl help <command>` print help and exit 0 before anything else runs: no config is read, no
browser opens, stdin is not read, and no file is written. The top-level help lists every
command with one line each. A command's help lists every flag it takes. Both come from one
command table in `src/surfaces/cli-commands.ts`, and a flag the table does not list for that
command is refused with exit 2 and a pointer to `usabl <command> --help`, instead of being
ignored. An unknown command exits 2 and points to `usabl help`. There is no `--version`.

A local `usabl check` that ends in `approval_required` also prints the next step: commit the
guarded files (a code owner approves them on a pull request). When no UI file changed, it
says no screen was scanned and that `usabl baseline`, after the commit, scans every mapped
screen. When every touched screen opened and was measured, it says their accessibility
barriers are listed above. A screen that did not open, or was not fully measured, is still in
`screens`, as a scan with a gap. Only a scan with no gap counts as measured. When some touched
screens were measured and some were not, it gives both counts and points to the "not evaluated"
lines. When none was measured, it says no screen was measured and points to the same lines. The
verdict and the exit code do not change. A run with `--trusted-ref` or `--json` prints no such
lines.

**Typical uses:**

- Local: `usabl check` (the default) on changed files or named surfaces.
- First-run policy drafts: `usabl init` infers and writes `usabl.config.json` and
  `usabl.routes.json` only. `--app <dir>` drafts one app folder in a repository that holds
  several (see section 12). It never calls the gate and never consumes the files it just
  wrote, and it refuses to overwrite existing files unless `--force` is given (`--force`
  is init-only draft overwrite, not a gate bypass).
- Integration wiring: `usabl install <target>` wires exactly one integration surface per
  run. The targets are `--overlay`, `--claude`, `--claude-skill`, `--cursor`, `--ci`,
  `--docs-ci`, and `--branch-rule`; zero or more
  than one refuses with exit 2. `init` scaffolds policy; `install` wires integrations; they
  are different commands (see section 12).
- Sign in once: `usabl session` opens a browser at the app, the person signs in, and it saves the
  Playwright storage state to `.usabl/session/storage-state.json` (0600, in a 0700 folder) only
  where git ignores it. Later runs sign in with it (see "Where the session comes from").
- Baseline drafts: `usabl baseline` runs two full UI scans and writes `.usabl-evidence.json`
  as a reviewable working-tree diff, holding only what both scans found. It lists the rest as
  intermittent, by screen and rule, and says how to handle them (see Evidence floor). A floored
  entry either scan did not see and cannot confirm was fixed is carried into the new floor at its
  recorded count, with or without `--partial`. It refuses when such an entry is a version 1
  placeholder count (exit 3), and when the floor it would replace exists and does not parse
  (exit 4).
- Floor prune: `usabl floor prune` re-arms the gate on cleanly scanned screens. It removes
  entries whose identity is gone, and lowers the recorded count on entries whose identity is
  still present but now holds fewer barriers. An absent entry the run cannot confirm was fixed,
  because nothing shows its part of the page rendered (section 9), is kept and named;
  `--unconfirmed` removes those too and says how many and why. The report says it kept entries on
  screens the run did not scan cleanly only when it kept some. It scans every docs page source in
  the manifest as well as uiFileGlobs, the same way baseline does, so a docs entry can be confirmed
  or removed. It never raises a count and never adds an
  identity: accepting new debt is what `usabl baseline` does, under review. It leaves version 1
  name and structural counts alone, because those are placeholders the gate does not compare and
  writing a real number under them would present a placeholder as an observation. It keeps the
  version it read and writes every other top-level field back as it was, in its place, so a
  `scope: "partial"` floor stays partial and a field from a newer floor survives. `prune` is the
  only subcommand; anything else exits 2. With debt tracking on, prune is an escape hatch rather
  than a routine step: a fix that two scans of main confirm already closes its slot (section 9).
- Debt: `usabl debt` lists the remaining accessibility debt by screen and rule, with the date
  each was first seen on main, its age in days, its trend (falling, rising, steady, or no data),
  and how many barriers are intermittent. It reads the floor (at `--trusted-ref` when given) and
  the history branch, scans nothing, and decides nothing. With tracking off it lists the floor
  and says why the dates are missing and how to turn tracking on. `--json` prints the same data.
  `--out` is refused there, because plain `usabl debt` writes no file.
- Debt ledger: `usabl debt ledger [--json] [--out <file>] [--trusted-ref <ref>]` is the ledger of
  how long accessibility barriers stay open (section 9, The ledger). It reads the floor history of
  the trusted ref (default `HEAD`) and the history branch as committed objects, prints a table
  sorted by days open with a totals line, and writes the full ledger as JSON only when `--out`
  names a file. Each row is open, fixed (two clean scans), left the floor, or reopened, and its days
  say which way they can be wrong. Open rows count to the commit the ref names; it reads no clock.
  It decides nothing. Exit 0 when it ran, 2 when no floor was ever committed, 4 when git cannot
  run there or the history is larger than its limits.
- History: `usabl history record --out <file>` scans every screen of main and writes one history
  record to the file; `usabl history append <file>` adds it to the local `usabl/history` branch
  on top of `origin/usabl/history` and never pushes. Both run only in the default-branch
  workflow (section 9, Debt history). Record refuses a run that never saw the application, a run
  with nothing to check, and a checkout whose guarded files differ from HEAD. Append refuses a
  record or a history it cannot read and writes nothing then.
- Judge build: `usabl extract-build --archive <file> --into <dir>` reads every tar header first
  and unpacks only regular files and directories into a new, empty directory, refusing the whole
  archive on a link, a device, an absolute path, a `..` segment, or an archive over its bounds:
  2 GiB of archive, 64 KiB for one long-name or pax record, 100,000 members, and 2 GiB of
  extracted files, each checked on the declared sizes before anything is allocated or written
  (exit 1; exit 2 on bad arguments). `usabl serve-build --dir <dir>` serves it with GET and HEAD only, realpath
  containment, nosniff, and the root `index.html` for an extensionless path that has no file.
  With `--trusted-ref <ref>` it binds the loopback origin of `appBaseUrl` at that ref and refuses
  any other; with `--port` (and `--host`, default `127.0.0.1`) it binds what it was given. Both
  run only in the generated CI judge (section 11.4).
- Routes drift: `usabl drift routes` compares `usabl.routes.json` against the app router.
- Design drift: `usabl drift design` lists the approved requirements whose Figma design file
  changed after they were recorded (section 13.2). It exits 0 with no drift, 1 with drift, and 2
  when it could not check. `routes` and `design` are the only drift subcommands; anything else
  exits 2.
- Design import: `usabl import figma <file key> --frame <Frame name>=<surface id> [--frame ...]
  --out <file> [--owner <name>] [--min-target <css px>]` writes draft requirements, each with
  `approved: false`, from the accessibility stamps in a Figma file (section 13.2). It never
  overwrites a file. It exits 0 when it wrote the file and 2 otherwise. `figma` is the only source.
- Health check: `usabl doctor` is a read-only projection over the wired surfaces and always
  exits 0 (see section 11.9).
- Task brief: `usabl brief [--files <path> ...] [--json]` prints what an agent reads before it
  starts a task (see section 11.5). With no `--files` it uses the changed files git reports, the
  same way a local `usabl check` does.
- Sensitivity evidence: `usabl verify sensitivity [--app] [--screen <id> ...] [--json]` puts each
  declared defect in its catalog on a page in the scan browser and records whether the real checks
  and the real gate catch it, in `.usabl/sensitivity.json` (see section 25). It is measurement: it
  mints no verdict and no receipt. It exits 0 whenever it ran and wrote the file, 2 when a flag or
  the config is wrong, and 4 when it could not run.
- CI: the workflow invokes `usabl check --ci --trusted-ref <base>`. On `check`, `--ci` is
  the CI-mode boolean and forces `--trusted-ref` (without it, `check --ci` refuses with
  exit 2). The same `--ci` token is the CI *install target* under `usabl install`; the two
  meanings are disambiguated only by the command.
- Comment: `usabl comment` reads a Result from stdin and prints the PR comment Markdown.
- Enforce: `usabl enforce accessibility` and `usabl enforce policy --trusted-ref` read
  Result JSON from stdin. They project CI status. They never call the gate and never mint a
  verdict. GitHub stays out of `run()`. `enforce accessibility` exits 0 on no accessibility
  verdict only when the Result also says nothing was to check (`coverage.nothingToCheck` is
  exactly true), which is the idle run. No verdict with exit 0 on any other Result exits 4 with
  "accessibility: no verdict", the way the comment and the Stop hook read it.
- Both read the Result as a document someone else wrote, so both check the whole document against
  the Result contract before they use any of it: every list is a list, every count is a whole
  number, every enum value is one of its values, and every nested object has the fields the
  contract gives it. A field the contract does not name is dropped. A document that does not
  match, or text that is not JSON, exits 4 with a plain reason on stderr that names the field by
  its path, for example `findings[0].severity`, and never repeats the value. `usabl comment`
  prints no comment in that case. The check is of shape, plus two agreements. Each verdict must
  carry the exit code the engine writes for it (verified 0, regression 1, approval_required 2,
  not_covered 3), and a Result with no verdict must exit 0 or 4. The same holds for
  `accessibilityVerdict` and `accessibilityExitCode`. A document that shows one outcome and exits
  with another exits 4 and names the exit code field. And `verdict` and `accessibilityVerdict`
  must be a pair the engine writes: without a policy hold the two are the same verdict, or both
  null with the same exit code, and `approval_required` sits over any accessibility outcome,
  an idle scan included (`accessibilityVerdict` null, exit 0), but never over exit 4. Any other
  pair exits 4 and names `verdict`. The check does not test whether the other
  values agree with each other, so a well-formed document is still only as true as whoever wrote
  it, and the receipt, not the document, is what proves a run happened.
- Library: the stop hook, overlay, and an optional MCP wrapper import `run()` directly.
  No MCP surface is built today (section 11.5).

Does not replace the stop hook for the AI-gating story. It enables the baseline pass
that makes the ratchet meaningful. `usabl init` still does not write
`.usabl-evidence.json` or waivers, while `usabl baseline` drafts the evidence floor
as a working-tree diff for review and merge.

### 11.2 Stop hook (headline)

Fires on the assistant's Stop lifecycle event. Behavior matrix:

- The repository root, then the config, before anything is parsed. The hook finds the
  repository root with `git rev-parse --show-toplevel` from the folder it starts in, because
  that folder follows the assistant when it changes directory. When `CLAUDE_PROJECT_DIR` is set
  and names a folder, the hook starts there; Claude Code sets it to the project root. The
  config, the receipt, the bypass file, the scan, and the session pin key all use the root. The
  hook then compares the raw bytes of
  `usabl.config.json` in the working tree with HEAD:
  - HEAD has the config and the working copy is the same bytes: the hook parses it and goes on.
  - HEAD has the config and the working copy differs, is missing, or cannot be read, or the
    config does not parse: block as approval required, before anything parses the working
    copy. The reason opens "NOT verified - approval required:", says what happened and that
    nothing was checked, tells the model not to edit the file to clear it, says what clears it,
    and names `usabl bypass`. Read and parse errors go inside the untrusted frame.
  - Neither HEAD nor the working tree has the config: allow with "NOT verified - usabl is not
    configured here: ..." and the step to run `usabl init`. Nothing runs.
  - The working tree has the config and HEAD does not, but HEAD exists (a new, uncommitted
    setup): the guard reports `usabl.config.json` as a changed guarded file, as it does for any
    new guarded file, so the run goes on and ends `approval_required`, which blocks. A new
    config that does not parse blocks as approval required before the run.
  - A repository with no commits yet, or an orphan branch with no commit yet, has no HEAD. The
    hook parses the working config and goes on, and the guard then fails to read HEAD. The stop
    fails open with disclosure: "NOT verified - stop hook error: ...", with git's "make a first
    commit" step inside the untrusted frame. It does not block.
  - The guard or the session pin computation fails for any other reason, such as a git listing
    past the read limit: the hook cannot tell whether guarded policy changed, so it blocks with
    "NOT verified - approval required: usabl could not tell whether guarded policy files changed,
    because the guard failed ..." and the error's first line inside the untrusted frame, as it
    blocks for diverged guarded files. Before, such a failure fell to the internal error allow
    below.
  - Reading or checking the stored receipt fails: the receipt only offers a fast allow, so the
    hook drops the fast path and runs the full check, and the decision is the run's.
  - Neither HEAD nor the working tree has the config, but this session already recorded pins for
    this repository root: an earlier stop read a committed config, so the config was removed and
    committed during the session. That is drift, and the stop goes through the drift block, with
    `drifted files: usabl.config.json` inside the frame.
  - The hook found no git work tree from the folder it started in, for example `.git`: allow
    with "NOT verified - the stop hook ran in a folder outside any git work tree, or git could
    not run there ... so it could not find the repository and checked nothing on this stop.",
    the folder inside the untrusted frame, and the step to run `usabl check` from the project
    root. "usabl is not configured here" is only for a real repository with no config.
  Each of these blocks lets one continuation through while `stop_hook_active` is set (Cursor:
  `loop_count` above 0), marked NOT verified, as every other block does. A continuation that
  goes through tells the model not to edit the file to make a later stop pass; only a block
  speaks of clearing it.
- Input that is not JSON: allow with "NOT verified - the stop hook got input it could not read, so the stop went through and nothing was checked on this stop.", then the step to check the hook command in `.claude/settings.json` or `.cursor/hooks.json`, run `usabl doctor`, and run `usabl check` before calling the change accessible.
- An internal error: fail open with disclosure. The runner prints "NOT verified - stop hook error: ..." and allows, never a silent allow. Git failing to read the config at HEAD is such an error. A run that started and failed with no verdict, and with no diverged guarded file, prints "NO VERDICT: RUN FAILED (exit 4): usabl is not blocking this stop, but the run did not finish, so it proved nothing about this change." followed by "Next: run usabl check again, or check the change by hand, before you call this change accessible." and allows.
- Where a person sees an allow's notice. Every allow writes its lines to stderr. Claude Code
  does not show the stderr of a Stop hook that exits 0, and sends its plain stdout to the debug
  log. So in the Claude protocol, an allow also writes one JSON object to stdout,
  `{"systemMessage": "..."}`, with the same text stderr gets, and Claude Code shows that field to
  the person. It is shown for every allow except a verified stop and an idle stop that carry no
  notice. So it covers every "NOT verified" allow, the "not configured" and "outside a work tree"
  allows, a run that failed, bypass, every continuation, the pin notices, the "NOT saved" receipt
  notice, and the invalid input message, and a verified or idle stop that carries a notice gets
  the whole text. An idle stop means no UI file changed; it is not a failure to check, and a
  message on every such stop would be noise. Carried values in it are scrubbed and framed as on
  stderr. A verified or idle stop with no notice writes nothing to stdout. A block is sent
  as before, as one decision object, and its notices follow on stderr. Cursor's stop hook
  answer has no field for the person: usabl answers `{}` and writes the notice to stderr, which
  Cursor does not show in the chat. It is in Cursor's hook output log (the Hooks output
  channel), which a person has to open.
- Diverged guarded policy on a run with no verdict: block, whatever the exit code. `run()`
  ends a run where every screen was unseen with no verdict and exit 4, and the guard still
  reported the diverged files on it. The hook counts those and the ones its own guard found
  before the run, so a crash that carries none still blocks. The line opens with the run's
  own verdict word, for example "NO VERDICT: RUN FAILED (exit 4): NOT verified. Guarded policy
  files changed, so this change needs approval whatever the run found.", then the approval
  step and the guarded file lines, with the paths inside the untrusted frame. During an active
  continuation it allows once, marked NOT verified.
- usabl not installed: the generated hooks run `npm exec --no -- usabl stop-hook`, which never
  downloads a package. It runs a local or global install, or a copy already in npm's own cache,
  and with none of those it makes one registry request and fails. The generated Claude command is
  a POSIX shell line (`npm_config_loglevel=silent npm exec --no -- usabl stop-hook || { ...; exit
  1; }`). On Windows it needs Git Bash, which is the shell Claude Code uses there by default. When usabl cannot run, the hook prints one line, "NOT verified - the
  usabl Stop hook did not run, so nothing was checked on this stop. ...", with how to install
  it, and exits 1. Claude Code treats exit 1 from a Stop hook as a hook error that does not
  block: the stop goes on and the user sees the line. Cursor treats it as a failed hook and lets
  the agent finish. Neither reads it as a pass, and neither is a block a person must clear.
- Nothing to check (no UI files in the diff): allow with explicit "nothing to check"
  message. Not `not_covered`.
- Valid receipt on an unchanged tree: fast allow in under 20 ms, no browser. The session
  pins are read and compared first, with every refusal described under Session pinning, so a
  stored receipt never allows a stop that the pin comparison would block. A receipt binds the
  committed policy as it was when the receipt was minted. A policy weakened and committed
  during the session, then checked under the weaker policy, mints a receipt that matches, and
  only the pins see that drift. The fast path records or replaces pins exactly as a full run
  does. The line reads "VERIFIED (exit 0, stored receipt, not re-scanned): this result comes
  from a stored receipt. usabl did not scan this change again on this stop. The receipt matches
  this tree, the committed policy, the engine, and the scanners. You may stop." When this stop
  compared the pins and found no drift, "Guarded policy files match the session pins." comes
  before "You may stop." When the pins were not used, the parentheses also carry the
  `session drift not checked` note and the pin notice follows on stderr, as on a full run.
  A receipt is a local file with no signature. A user with a shell on the same machine can
  write one that verifies, so the line says where the result came from (threat model, Threats
  1 and 4).
  Detected drift prevents the fast allow: the stop blocks whether or not a receipt matches,
  and during an active continuation it allows once, marked NOT verified, with the pins kept.
  The receipt's `sourceTree` follows inside the untrusted frame, because it was read from a
  file in the work tree.
- A stored receipt that does not verify: the hook runs the full check, as before. When the
  receipt's tree still matches, so something other than an edit stopped it, a notice follows
  the decision line: "Note: The stored receipt for this tree did not verify, so this stop ran a
  full check instead of using it. Why: ..." with one plain reason per failed binding, for
  example that a waiver the receipt relied on ended at a given time. The reasons are usabl's
  own sentences, each bounded. A receipt that did not verify because the files changed adds no
  notice, so a verified stop after an edit stays quiet. The notice appears only when the full
  check reached a verdict: an idle run checked nothing, and a run that failed proved nothing, so
  those stops read as they would with no stored receipt.
- Saving the receipt: only a verified local run saves one, at `.usabl/receipt.json`. The Stop
  hook reads and writes it under the repository root; `usabl check` writes it in the folder it
  runs in. `usabl check --ci` saves none. The write refuses a symbolic link at `.usabl`
  or at the receipt file, writes a temp file opened with no-follow and exclusive create, and
  renames it into place, as the session pin store does. A save that fails for any reason, a
  refused link or an error such as `EACCES`, changes no verdict: the hook says "NOT saved -
  usabl did not save the receipt ..." after the decision line, and the next stop runs the full
  check. For an error, the first line of the error follows inside the untrusted frame under
  `reason:`.
- `verified` on a fresh scan: mint receipt and allow. Mint only after every affected
  surface was scanned. Never mint on a sample. The meaning line on every surface is
  "No new accessibility barrier blocks this change. It can proceed." and the stop hook allows with
  "VERIFIED (exit 0): the gate verified this change. You may stop.", followed by the
  receipt's `sourceTree` inside the untrusted frame when there is a receipt, with advisory
  findings shown adjacent when present. Not "no barriers": a verified run routinely
  carries barriers the floor recorded.
- `regression`: block.
- `approval_required`: block.
- A verdict that is not one of the contract's words, on any exit code, exit 4 included, or a
  null verdict on a run that was neither idle (`nothingToCheck`) nor a crash (exit 4): block. The line reads, for example,
  "UNRECOGNIZED VERDICT (exit 1): NOT verified. usabl does not recognize the verdict this run
  reported, so the run proved nothing about this change." or "NO VERDICT (exit 0): NOT verified.
  usabl did not reach a verdict for this change, so the run proved nothing about it.", followed by
  a next step to run the check again and the gate's summary inside the untrusted frame. The
  carried verdict is never printed. During an active continuation it allows once, marked NOT
  verified, like every other blocking state. The self-check prints the same words. The stop hook
  and the self-check both read a run as idle only when `nothingToCheck` is the boolean `true`; a
  null verdict with any other value, such as `1` or `"true"`, blocks.
- `not_covered`: default block. Recalibrate from real-repo measurement
  (section 25) if this drives persistent bypass behavior.
- Policy mismatch against git anchor: block.
- One-continuation escape: at most one forced continuation, then a loud disclosed
  allow marked "NOT verified."
- Hook error: fail open with disclosure, never a wedge.
- Sealing is by carrier, the same rule the pull request comment follows. Every value the
  Result carries is printed inside the untrusted frame or is type-checked first, whoever
  wrote it. Outside the frame the stop hook and the self-check print only usabl's own words,
  counts and exit codes checked to be whole numbers, and a finding's status and severity
  checked to be one of the contract's words ("unknown" otherwise). A barrier's rule, layer,
  and screen id, the guarded file paths, and the receipt's `sourceTree` are inside the frame.
  An accessibility barrier's headline outside the frame reads
  `- accessibility barrier 1: [new serious] (×3)` under the heading `Accessibility barriers:`,
  and its pieces inside the frame carry the same number:
  `accessibility barrier 1: axe/color-contrast`, `screen (1): ...`, `experience (1): ...`,
  `fix (1): ...`. One reads `Accessibility barrier: [new serious] (×3)` with
  `accessibility barrier: <layer>/<rule>` and `screen: <id>` inside, then its experience and
  fix. When guarded files changed,
  the scaffold line gives their count, for example `Guarded files changed: 2, named under
  "guarded files" in the untrusted text below`, and the piece `guarded files: <paths>`
  follows the gate's summary and is never dropped when the message is shortened. A field
  that should be a list and is not is reported as unreadable rather than walked. A verdict
  that is not one of the contract's words is printed as an unrecognized verdict on every
  surface, including a name every object inherits, such as `toString`, which a plain table
  lookup used to find and print as the source of a function.
- When a message is over its budget, whole barriers are dropped first, from the last one: a
  barrier's headline goes with its pieces in the frame, so no headline is left whose rule is
  nowhere in the message. Coverage gap lines go only after every barrier is gone. The note
  says how many lines and how many barriers were left out, in the form "[shortened to fit
  the message budget, N line(s) omitted (K accessibility barrier(s) left out); run usabl check --json for
  the full list]", and the show-all hint counts only the barriers still shown.
- A findable single-run bypass (the "usabl bypass" command writes a one-shot .usabl/bypass-once file) so a wrong block means "bypass once and
  file it," not "delete the hook."

### 11.3 Overlay (dev-server)

On save, the overlay client requests a scan from the same engine as the stop hook
(single-flight per repo so hook and overlay do not storm browsers). It renders
`Result`. It never constructs a Verdict and never blocks the page. It is advisory: the
client runs inside the tested page's own JavaScript realm, so the page can interfere with
what the overlay shows; the gate computes the verdict and the CLI and CI enforce it. Oracle-preserving:
mounts only when `navigator.webdriver` is false and `?usabl=off` is not present.

The Vite plugin adds the overlay loader to the page only in `vite serve`. In `vite build`, and
before Vite has resolved its config, `transformIndexHtml` returns the HTML unchanged, so a
production bundle never carries a loader for `/__usabl/client.js`, a module only the dev server
answers.

The overlay and the CLI start the scan browser through the same shared browser in
`src/deps/real.ts`, so both ask for Chromium's sandbox, fall back the same way, and honor
`browserSandbox` (section 22). When a scan ran without the sandbox, the dev server output says so
once per dev session, and the Result carries the note on each screen.

In `vite serve` only, the plugin adds `data-source-file` and `data-source-line` to each component
and HTML element opening tag in the application's `.tsx` and `.jsx` files, so a finding can name
the line that rendered the element. The plugin runs before the host's JSX transform
(`enforce: 'pre'`), so it reads raw TSX. It parses each file with `@babel/parser` and puts the
attributes after the tag's last attribute, or right after the tag name and any type arguments
when the tag has none, so an element such as `<PageWizard<Data>>` stays valid and a
`data-source-file` carried in a spread such as `{...rest}` cannot replace the element's own
location. Legacy decorators are read, and a `.js` or `.jsx` file that does not parse is tried
again with Flow types. Strings, comments, types, and generic arrow functions are not
tags in the syntax tree and are never touched. A namespaced tag such as `<svg:rect>` is left as
written. A file the parser cannot read is served unchanged, with one warning in the dev server log
that names the file. Its elements carry no source line, and the application still runs.

The webpack plugin (`usabl/webpack`, `UsablWebpackPlugin`) serves the same overlay to an app
that `webpack serve` (webpack-dev-server 5) runs. Both plugins sit on one shared host
(`src/surfaces/overlay-host.ts`), so the client, the result projection, the cached run, the
Host and Origin checks, and the source transform are the same code. The webpack plugin acts only
when webpack's mode is `development`. In `production`, in `none`, and with no mode at all (which
webpack treats as production), it adds nothing: no loader, no entry, no dev server hook, so the
built bundle carries no source attributes and no overlay loader. In development it adds a
pre-loader for `.tsx` and `.jsx` files outside `node_modules` that applies the same transform,
before ts-loader or babel-loader rewrite the JSX. It adds an entry to every bundle that loads
the client as a module script, with the same `navigator.webdriver` and `?usabl=off` rules. It
wraps `devServer.setupMiddlewares` so the overlay paths answer before the app's own middleware.
`webpack serve` reads the dev server options from the compiler after plugins are applied, which
is why one plugin entry is enough. A dev server started from code must be given
`compiler.options.devServer` for the same reason. webpack-dev-server has no channel a plugin can
send its own event on, so the plugin serves `/__usabl/events`, a server-sent event stream that
carries the refresh event name and nothing else, under the same Host and Origin checks. A change
webpack reports (`invalid`) drops the cached result. webpack watches only the module graph, so
the plugin also adds `usabl.config.json`, `usabl.routes.json`, `.usabl-evidence.json`, and
`.usabl-waivers.json` to each compilation's file dependencies. webpack is an optional peer
dependency: usabl imports nothing from it, and `require('usabl/webpack')` from a CommonJS
config needs Node.js 22.12 or later. rspack, Next.js, and other bundlers are not supported.

`usabl install --overlay` first works out which bundler the app uses. It counts a Vite config
(`vite.config.*`) or a `package.json` script that runs the `vite` command as Vite, and a webpack
config (`webpack.config.*` or `webpack.*.*` at the root, or a config a script names with
`--config`) or a script that runs `webpack` or `webpack-dev-server` as webpack. `vitest` and
`vite-node` are not Vite. When it finds both or neither it refuses with exit 2 and names
everything it saw, or everything it looked for. It never writes a `vite.config.ts` into an app
that does not run Vite. A Vite app with no config gets the draft, which Vite then loads. A webpack
app always has a config, and install never edits one: it names the dev config (the one a
`webpack serve` script names, else a `webpack.dev.*` file, else `webpack.config.*`) and prints
the two lines to add, in `require` or `import` form to match the file.

### 11.4 CI/PR comment (trusted-ref policy read)

Reads policy from the protected branch (or the trusted ref), never the working tree.
Refuses to run without a base ref. The comment leads with the headline
(`## usabl report: <VERDICT>`), then on approval required the policy split line, then the
receipt (`_No receipt: run was not verified._` when none), then `### Conformance summary`
(whose `deterministic:` entry splits new into failing and unconfirmed when any is new),
then `### Accessibility debt` when the floor holds debt or the change fixed some, for example
"This PR fixes 2 accessibility barriers. 14 remain; the oldest has been open 41 days. 1 is
intermittent.", followed, when automatic tracking is off, by why and how to turn it on,
then the finding sections `### New accessibility barriers`, `### Known (recorded debt)`, and
`### Advisory (non-gating)`, or `### Findings (collapsed by rule)` for the deterministic lane
when the noise budget collapses it, then `### Coverage gaps`, then
`### Disclosed, does not block` when any screen carries a provider note, and
`### Announcements (current run)`. The notes section is disclosure only and never changes
the verdict. The terminal summary, the self-check, and the Stop hook print the same notes
after the gaps under `disclosed, does not block`. The known section lists carried and waived deterministic
findings, each with its status, the same recorded debt the terminal and the overlay list. A
collapsed group holds findings of one status, and names its screen id and rule once, in its
headline. Its hint calls the findings gating only when every one of them gates. All page-derived text passes through `neutralize()`. Sticky comment
matched only among bot-authored comments (keyed by `<!-- usabl-report -->`). On
`approval_required` the comment stays loud after the policy check is green.

**Size bound.** GitHub refuses a comment body over 65,536, and the required check then fails
with no comment. The comment body, counted with the newline the CLI writes after it, is at most
60,000 UTF-8 bytes (`COMMENT_BODY_LIMIT` in `src/surfaces/pr-comment.ts`). Whether GitHub counts
characters, UTF-16 code units, or bytes has not been checked live. A text is never fewer bytes
than code units, or fewer code units than characters, so the body is under 65,536 in each.
Every carried value is cut to a fixed length, marked `[shortened, N characters omitted]`.
Coverage gaps are named up to 20 per state, and one line counts the rest of each state, as the
transcript names up to 20 stops per screen. When the body is still over the bound, whole items
are cut, lowest priority first: announcements, disclosed notes, advisory findings, recorded
debt, notices for floored accessibility barriers not seen, gaps after the first of each state, the framed
detail under a gating finding, and last a gating finding's first line. The marker, the verdict
line, the approval line, the judge line, the receipt, the conformance counts, the debt lines,
and the first coverage gap of each state are never cut, so every gap state the run had stays
named. Each section that lost items says how
many, and one note under the verdict says how many in all and that the full Result is
`usabl-result.json` in the `usabl-result` artifact. A gating finding's first line is cut only
when those first lines alone pass the bound, which needs an operator to raise the noise budget
until hundreds of gating findings are listed one by one; the comment then keeps as many as fit,
in the gate's order. The bound changes what the comment shows, never the verdict.

**Two shapes.** `usabl install --ci` and `usabl install --docs-ci` *generate* a six-job
workflow in the consuming repo. `usabl-engine` checks out the public `usabl-dev/usabl` at the
engine pin (see "The engine pin and the install report" below), with no token, builds it, and hands it on as an archive with an `engine_digest` output.
`build-app`, fenced to `pull_request`, is the only job that runs head code and holds no secret;
it packs the build output (repository variables `USABL_APP_BUILD_COMMAND`, default
`npm run build`, and `USABL_APP_BUILD_DIR`, default `dist`) with a `build_digest` output.
`usabl-scan`, the trusted judge, runs on both events: it unpacks the build with
`usabl extract-build`, serves it with `usabl serve-build` on the loopback origin of the trusted
`appBaseUrl`, runs `check --ci --trusted-ref <base SHA> --isolated-browser`, and publishes
`verdict` and `result_digest` outputs. `gate-comment` posts the comment from the digest-checked
Result, or writes it to the run summary on a pull request from a fork. `usabl-policy` runs
`usabl enforce policy --trusted-ref <base SHA>` with the head read only as git objects.
`usabl-required` (`if: always()`, needs all five) sets the required status. Serving, scanning,
policy, and the comment all read the one base commit the event names, never a branch ref.
Each gate triggers on pull requests into one branch, written quoted in its `pull_request`
trigger. The installer takes it the way it takes the history workflow's branch (below): from
`refs/remotes/origin/HEAD`, a plain name only, main and a printed step when git names none, and
the branch already in usabl's own file kept on a re-run. That trigger line is the only line of a
gate that changes with the branch, and the file then names the branch: doctor and the installer
recognise usabl's own draft for whichever plain branch the trigger names, and any other trigger
form is drifted. The branch filter applies to the `pull_request` event only. GitHub takes no
branch filter on `pull_request_review`, so a review on a pull request into any branch starts the
gate. The judge then looks for the `pull_request` run that built this exact pull request, head,
and base (below). A pull request into another branch normally has none, so the judge fails closed
and `usabl-required` reports red on it; that red check blocks nothing on a branch that does not
require it. When the gate, the docs gate, and the history workflow on disk name different
branches, the installer prints one step naming each file and its branch, and changes none of
them. A gate, docs gate, or history workflow that is byte for byte the unedited draft an earlier
0.3.0 build wrote (a gate triggering on an unquoted `[main]`, and older comment text) is rewritten
to this draft with the engine pin it held, if it held one. The rewrite line says when the trigger
moved, from which branch to which, and the line to change to put it back (`origin/HEAD` can be
stale after a rename), and says to commit the file. Doctor reads such a file as drifted and says
to run the installer; it says the pin is kept only when the file has one. The step that places
the engine at `../usabl` skips the unpack when that path is the checkout itself (a repository
named usabl). It prints one line that also says an app installing usabl from `file:../usabl`
cannot build there, and that renaming the repository fixes it.

**The engine pin and the install report.** `npm run build` ends with
`scripts/write-build-info.mjs`, which writes `dist/build-info.json`: the package version, the
commit (`git rev-parse HEAD`, or null outside git), and whether the tree was clean (no
uncommitted change and no untracked file). The package carries the file. `install --ci` and
`install --docs-ci` read it next to the running code (`src/install/build-info.ts`) and write the
commit as the engine ref only when it is a full 40-character lowercase SHA and the tree was
clean. Otherwise the ref is the `PIN_TO_A_TRUSTED_USABL_COMMIT` sentinel, the report says why,
and it names the line to edit in each file. Nothing reads the network. A sentinel, or a commit
that cannot be fetched from `usabl-dev/usabl`, makes the engine checkout fail, so the gate blocks. Each
workflow file is written when absent, left alone when identical, filled in when it is the
unedited sentinel draft and the build has a commit, left alone with its commit named when it is
the draft pinned to another commit, and refused when anything else differs. `usabl doctor`
still reads a workflow that holds the sentinel as not wired: the gate on its `ci` line, the docs
gate on its own `docs-ci` line, and the history workflow on its own `history-ci` line, each
recognised for whichever branch its trigger names and labelled with that branch (no docs gate
and no history workflow read as missing, since both are optional). The report lists the outcome for
each file, then the facts once, then the steps still needed: pin the engine (only with the
sentinel), run `usabl init` or fix `appBaseUrl` (only when `usabl.config.json` has no loopback
http `appBaseUrl` with a port), add a `dev` script (`install --ci` only, when `package.json` has
none), merge `usabl.config.json` (and `usabl.routes.json` when the working tree has one) to the
default branch first in their own pull request (for `install --docs-ci` the files are
`usabl.config.json` and `usabl.docs.json`, and `usabl.routes.json` when the working tree has one;
left out when git shows that `refs/remotes/origin/<default branch>` already holds the same
bytes; the judge reads them at the base commit, so a pull request that adds them with the
workflows cannot pass), check the branch name (when git names no default branch) or make the
files name the same branch (when they differ), and, when a file
was written, commit, add the branch rule, and open a pull request. Before
init, the report reads the port from a `--port` in the `dev` script, `server.port` in the Vite
config, or `devServer.port` in the webpack dev config (a literal, a module-level binding to one,
or `process.env.NAME || <literal>`), and otherwise lists every place it looked. No workflow takes
a port from the installer.

No trusted job extracts an artifact with `actions/download-artifact`, whose zip extraction
follows a `..` in the middle of an entry name. Each writes usabl's own fetcher
(`FETCH_ARTIFACT_SCRIPT` in `src/install/artifact-fetch.ts`, Node builtins only) and runs it with
the job's token (`actions: read`): it lists the run's artifacts through the REST API, downloads
the newest under the name with a size bound (engine 512 MiB, build 2 GiB, Result and history
record 64 MiB), accepts only the exact expected file as a regular file, refuses any other entry,
path, link, duplicate, encryption, or zip64 before it writes, and writes into a new directory
outside the workspace. The file is then checked against the producing job's digest output. The
engine job also publishes `engine_tree_digest`, and every trusted step that runs the engine
checks the unpacked tree against it first. Every `setup-node` sets
`package-manager-cache: false`. On `pull_request_review` the judge takes the build from a
`pull_request` run named, through `run-name`, after this event's pull request number, head
repository, head SHA, and base SHA, in this repository and workflow file, whose latest
`build-app` job succeeded; it pages through every completed run, and finds none after the base
moved, so that review fails closed until the pull request runs again.

What the required check is worth. Any pull request, from a branch or a fork, runs the workflow as
the pull request changed it, so one that edits `.github/workflows/` can make `usabl-required`
pass whatever the judge found. The verdict on a pull request that edits the workflow is not
evidence. The protection is a branch rule or ruleset that requires review from code owners, with
`.github/workflows/` and the guarded paths owned in `CODEOWNERS`, so such a pull request cannot
merge without an owner's approval. `usabl install --ci` and `usabl install --branch-rule` say so;
`usabl install --branch-rule` verifies the required check, code-owner review, at least one
required approving review (a count of 0 requires no review at all), and dismissal of stale
approvals on push, each by classic protection or by an active ruleset, on the branch the gate
workflow on disk names in its trigger. With no gate workflow, it reads the branch the docs gate
workflow names, since the docs gate requires the same check, and its advice names
`install --docs-ci`. With neither, a trigger it cannot read, or a file it cannot read (a folder,
or no permission), it checks `main` and says it assumed it in each line that names it. An
assumed `main` is verified only when there is no gate file and GitHub reports `main` as the
default branch. When GitHub reports another default branch, or cannot say which one it is, the
result is "cannot verify": it names both branches when it can, and the next step. A default
branch name from GitHub that is not a plain name is neither trusted nor printed. A ruleset on
`~DEFAULT_BRANCH` counts only when the repository's default branch is that branch. When a gate
names one branch and GitHub's default branch is another, the output says in one line that the
gate covers only pull requests into the branch it names, and names the line to change. Each part
that is off is "not applied", and each it cannot read is "cannot verify". `usabl doctor` reports the same, with the branch lines in the next step; a verified branch that
is not GitHub's default branch reads as drifted, not wired. It also reports `workflow-owners`: wired only when the last
`CODEOWNERS` rule that matches each `.yml` or `.yaml` file in `.github/workflows/`, and the last
rule for any such file a pull request could add, names valid owners (`@user`, `@org/team`, or an
email). A later rule with no owner takes ownership away, and a pattern usabl cannot evaluate
reads as unknown. Only an organization-required workflow takes the
workflow out of the pull request's hands. See `docs/threat-model.md` (Threat 15
and "CI trust boundary") for what each job holds. The engine's own repo checks in the earlier
three-job shape (`gate-comment`, `usabl-policy`, `usabl-required`), because it has no app to
build. Because `classifyGateWorkflow` compares a workflow line for line against the draft,
`usabl doctor` reads the engine's own gate as `drifted`. That is the expected reading for the
one repository that is its own engine. The required status check named in branch protection is
`usabl-required` (the workflow *file* is named `usabl-gate`), and the protected branch is the
one the gate's trigger names (`main` in this repository). Both `enforce` commands read Result JSON from stdin and never call the gate.

In the generated gates, `usabl-required` reads seven values and nothing else: the event name,
the five job results, and the judge's `verdict` output. Every job result is an event-shape
check: on `pull_request` all five must be `success`; on `pull_request_review` `build-app` and
`gate-comment` must be `skipped` and the other three `success`. The verdict is a job output,
which only the judge's own steps can set, so code that replaces artifacts in the run cannot
change it. Anything else, an unknown event, a cancelled job, or any verdict that is not exactly
`pass`, blocks. The rule is one string, `REQUIRED_GATE_SCRIPT` in `src/install/ci.ts`, embedded
verbatim in both generated workflows; the engine's own gate embeds `ENGINE_SELF_GATE_SCRIPT`, its
three-job rule.

**The judge's browser.** `check --isolated-browser` reads the origins the browser may reach from
the trusted ref: the `appBaseUrl` origin, the `docsBaseUrl` origin when `usabl.docs.json` exists,
and `judge.allowOrigins` in `usabl.config.json` (bare http or https origins, dropped when the
trusted config cannot be read). With a trusted ref the judge runs on `usabl.config.json` at that
ref, the readiness budget and every other setting included; the head's copy is never parsed, only
compared by the guard, so an invalid or rewritten head config is a policy change and does not
stop or steer the scan. When the trusted ref has no readable config, the head's copy plans the
run with `readyTimeoutMs`, `signalTimeoutMs`, `browserSandbox`, and `judge` removed, and no origin
is allowed. It requires Chromium's sandbox whatever `browserSandbox` says, and aborts every
request and WebSocket to any other origin. Service workers are allowed, and their requests pass
the same filter. Readiness waits for their requests and their install and activation, as for any
scan (see "Readiness waits for service workers"). It also catches what the route cannot stop: a redirect hop to an origin outside
the allowed set, or a redirect response whose Location points there, a response whose server address the URL should not reach (an IP origin answered
by another address or port, `localhost` off loopback or on another port, another hostname
answered by a loopback, private, or link-local address), and a WebSocket a worker opens outside
the allowed origins. Two worker paths pass no filter yet, so each makes the screen a gap whatever
origin it reaches: a shared worker starting, seen through target discovery on a browser session,
and a WebSocket a service worker opens, seen through the page's own debugging session, which
attaches to each service worker paused at start and turns its network events on before its script
runs. A service worker discovery saw that the session never watched is a gap too. Playwright
reports a shared worker's script request and never its end, so readiness also runs out on such a
page. A screen on which anything was blocked or caught gets a `not-covered` gap
that names the origins, never the path or query, and keeps its drafts. The Result gains a `judge` block (`isolatedBrowser: true`,
`blockedRequests`, and `buildDigest`, the sha256 from `USABL_BUILD_DIGEST` or null). It is
disclosure only: the gate never reads it, the Result reader refuses a malformed one, and the
summary and the comment show it in one line.

**The history workflow.** `usabl install --ci` also writes `.github/workflows/usabl-history.yml`,
the default-branch workflow that feeds the debt history (section 9). It runs on a push to the
default branch, once a day, and by hand, one run at a time. The installer reads the default branch
from `refs/remotes/origin/HEAD` in the app's clone and writes it, quoted, into the `push` trigger
and the `history-scan` job's `if:`; the report names it. A name with any character outside
letters, digits, and `. _ - /`, or no such ref, means not found: the installer writes main and
prints a step to change it on those two lines. A re-run keeps the branch its own file already
names. Those two lines are the only ones that carry the name; comments and step names say
"the default branch". It builds the engine with the same `usabl-engine` job
as the gate, and each later job fetches the archive and the record with usabl's own fetcher,
checks the archive against `engine_digest`, and checks the unpacked tree before each engine run. Its
`history-scan` job checks out the default branch, reads `appBaseUrl` from its `usabl.config.json`, starts
the application with `npm run dev -- --host <host> --port <port>` on that origin, runs
`usabl history record`, and uploads the record. An `appBaseUrl` that is missing, unreadable, or
not an http loopback origin with an explicit port fails the job before the application starts. It runs application code, so it reads only. Its `history-append` job needs
the scan, runs only the checked engine and no npm, appends the record with
`usabl history append`, and pushes `usabl/history` without force, fetching and trying again when
a push loses a race. It is the one job that holds `contents: write`, the one permission tracking
needs. GitHub cannot narrow that permission to one branch; a ruleset on `usabl/history` can. A
team that cannot grant it leaves the file out and keeps the floor-only behavior, and every run
says tracking is off. This repository's own workflows do not run it.

### 11.5 Mid-task self-check (CLI; MCP optional)

**What problem this solves.** The agent can verify its own work while context is warm,
before the Stop hook fires. The value is self-correction mid-task. The value is **not**
"MCP."

**How it works (default).** The agent runs `usabl check` through the host's
shell (Bash in Claude Code). Same `run()` → `Result` as every other surface. The Stop
hook remains the gate; this path only advises the agent. A CLI call works just as well
as an MCP call, so MCP is not required.

**MCP wrapper (optional transport).** Same engine, thin protocol adapter. Decide MCP
vs Bash-only on discoverability, not capability.

| | **CLI via Bash** | **MCP tool** |
|---|---|---|
| **Pros** | No server, protocol, or registration work. Same Result. Zero extra transport to test. No page text flowing into agent context as structured tool output (lower prompt-injection surface than MCP). | First-class tool with description in Claude Code; model more likely to call at the right moment. Structured content the model handles natively instead of stdout to parse. |
| **Cons** | Model may forget to self-check without prompting. Parses CLI text output. | Fourth transport over one engine (integration + test surface). Page-derived text (aria-labels, headings, errors) returns as tool output - prompt-injection surface the Stop hook does not open. Requires `neutralize()` and untrusted-data framing (section 17). |

**Sequencing.** The CLI mid-task check ships first. Add the MCP wrapper only if
reliable agent self-correction needs it. If MCP is added, it is for discoverability,
not because the loop requires it.

The gate stays at Stop. Neither path lets the agent grade its own work.

**Task brief (`usabl brief`).** Before it starts a task, the agent runs
`npm exec --no -- usabl brief --json --files <paths>` with the files the task will edit. At that point the
tree is usually clean, so a brief of the changed files would have nothing to check. The
installed `/usabl-check` skill and the Cursor rule open with that step, and the skill's
`allowed-tools` lists `Bash(npm exec --no -- usabl brief --json --files:*)`. The brief
names the screens the task's files reach and how each is reached, one entry per check the scan
would run on each screen, and what counts as done. A check entry says whether it applies and,
when that is not plain, why: an intake requirement (any kind but doc) applies only to
the screen it names, the
docs rulepack only to docs pages, an engine only when the config turns it on, and a check that
can only tell on a live page, such as the PatternFly rulepack looking for its marker, says
"decided on the page". The screens come from the planners `run()` calls, with the inputs a local
run gives them and joined in the same order, so for the same changed files the brief names
exactly the screens a local `usabl check` scans. Like a local run, it checks the guarded files
against HEAD and reads a `usabl.routes.json` or `usabl.docs.json` that differs from HEAD as
missing, and it adds a disclosure line for each such manifest. The checks come from the provider list the check runner is built with. The done list
restates the gate rules (section 9): no new deterministic failure, no new deterministic finding
usabl could not confirm, no coverage gap, approval for any changed policy file, and a live scan
when a screen needs one. When nothing is left to check, it says the scan gives no verdict and
points at the approvals line, because a changed policy file still makes the result
`approval_required`.

The brief is measurement. It opens no browser, so no page text is involved, mints no verdict and
no receipt, never calls the gate, and never reads a verdict. It reads policy from the working
tree and takes no trusted ref. CI judges a pull request on the trusted ref (section 10), so when
a task edits policy the brief can differ from what the gate decides. Every string it prints goes
through `scrub.ts` and loses credentials, query strings, and fragments. It exits 0 whenever it
printed a brief; a config or requirements file it cannot read fails the command with the reason,
the same way `usabl check` does.

### 11.6 Playwright helper (seam)

A documented entry point that returns the core Result. Teams can call the same check
from the tests they already run. A starting point, not the main surface.

`checkPage(page, options)` runs the same provider list the CLI runs on a screen. Both build
it through `makeScanProviders` in `src/providers/core-stack.ts`: the core stack, then one
provider per design requirement of any kind but doc, the name, heading, landmark, focus order,
and target size checks included (section 13.1). `checkPage` reads `usabl.config.json` from
`options.projectRoot` (default: the working directory) and loads the requirements directory it
names through the same loader as the CLI. It reads the working tree; it does not apply a
trusted ref. It never searches parent directories. When the caller passes `projectRoot` and
there is no `usabl.config.json` in it, that is a `not-covered` gap with ref
`usabl.config.json` whose reason names the root, because the caller pointed at a folder with no
config and nothing would be checked. When the root is the default and there is no config, that
adds no gap, because a project that does not use usabl config has none. Either way the result's
`project` field holds the absolute root that was read and whether a config was found there, so
a caller can tell an empty project from the wrong folder. A config or requirements directory
that is present and cannot be read is a gap. A requirements file that does not load is a gap
whose ref is that file, the same ref `usabl check` gives it.

`checkPage` is not a merge gate. Its verdict is advisory output for a test suite; the gate is
the only verdict authority. It also acts on the caller's page: the keyboard walk presses Tab,
the PatternFly probes open and close dialogs and menus, and each flow and voice requirement on
the page's surface runs its authored steps, clicks and key presses, on that page. A voice
requirement also waits for the page to settle after each step (section 7.5).

Only deterministic drafts decide the page verdict, as in the gate: a deterministic `fail` is in
`failures`, and a deterministic `unverified` is in `needsReview`. Any other draft, such as a voice
requirement's preview finding, is listed in `advisory` and never counted. `advisory` and its
summary line, `advisory: N preview finding(s), shown for review and never counted in the
verdict`, appear only when there is at least one such draft, so a page with only deterministic
drafts gets the result it got before.

The result's `notes` holds the provider notes for the page, such as design-system markup a
rulepack did not read. They are disclosure only and do not change the verdict. A page that
did not render as the screen it claimed returns no notes, as it returns no drafts.

`checkPage` scrubs its result before it returns it, because the result leaves usabl there. Every
string passes through the scrubber, and every URL in it, the page address in a gap ref included,
loses its sign-in credentials, query string, and fragment.

The browser behind that page is the caller's. usabl did not launch it and does not change it, so
`browserSandbox` does not apply, and whether that browser runs with Chromium's sandbox is the
caller's choice and the caller's exposure. Playwright's own launch leaves the sandbox off unless
the caller passes `chromiumSandbox: true`. The screens of a `checkPage` result never carry the
sandbox note, because usabl cannot tell how the caller launched the browser.

`adoptPage` installs the same live-region capture the CLI installs, from one shared source in
`src/deps/real.ts`. So a flow requirement that expects an announcement hears the same text in both.
On an adopted page the capture starts at adoption, not at document start, and it also starts in
any document the page navigates to afterwards.

When `checkPage` is done with the page, it releases what adoption added and nothing else: it
detaches its CDP session, which also ends the live-region capture and the accessibility domain
that session started, and removes its network listeners. The caller's page and context stay
open, so a test can go on using the page, and repeated checks on one page do not pile up
sessions or listeners.

The capture hears a change only when the region it falls in is live. It resolves the effective
live value with the same resolver `pf-toast-live-region` uses, carried into the browser as that
resolver's own source, so the two cannot disagree: the nearest element that sets a value wins,
an explicit `aria-live` beats the role, only the exact tokens `polite` and `assertive` are live,
and roles match without regard to case. A change inside `aria-live="off"`, inside an off wrapper
within a polite region, or inside a region whose token is `POLITE` or `banana` is not heard. Nor is
a change inside content hidden from assistive technology: anything on the walk with `inert`, with
`hidden`, with an `aria-hidden` value Chromium reads as true, or a closed `dialog` element. That is
every non-empty `aria-hidden` value except `false` and `undefined` in any case. A `dialog` is
closed when it has no `open` attribute: the browser renders none of its content and leaves it out
of the accessibility tree. The observer runs after the task that made the change, so a Save button
that writes `Saved` into a polite region inside its dialog and closes the dialog in the same task
is not heard: by the time the change is read, the dialog is closed, and no screen reader speaks the
text. The hidden state is read again at drain, the way the modal state is, so a region whose
dialog closes one task later, or after a promise that follows the write, is not heard either.
Anything that hides the region by the drain decides, which can only make the capture hear less.
Inside a live region, the capture records only text in the accessibility tree. A change whose
added nodes are all out of it is not recorded, and the text recorded for the region leaves out
every part under `aria-hidden`, `inert`, `hidden`, a closed `dialog`, `display: none`, or
`visibility: hidden`. So text written into a polite region only under an `aria-hidden` child, which
no screen reader speaks, cannot satisfy a flow's expected announcement. Text hidden only on
screen stays in the tree and every screen reader speaks it, so it is still recorded: PatternFly's
screen-reader class, a clip rectangle, a box of zero size, opacity 0, and a `display: contents`
wrapper. Visibility is read on the element that holds each text node, so a child that sets
`visibility: visible` inside a hidden wrapper is heard. It covers a region inside `aria-hidden="true"`, an
`aria-hidden` wrapper between the region and the change, and a region that is itself hidden. Orca
says nothing for a polite status inside `aria-hidden="true"`. `aria-hidden="false"` does not bring
back content an ancestor hides. A `hidden` attribute that page CSS overrides still counts as
hidden, which can only make the capture hear less. The walk climbs through a slot the way the
rule's walk does, but it runs in page script, so it sees only slots in open shadow roots. When
the live region it reaches sits inside a shadow root and the changed element is slotted into it
from outside, the change is not recorded. That region's own text leaves out the slotted text that
changed and holds text the change did not make speakable, such as slot fallback text, so recording
it could pass a flow requirement on words no screen reader spoke.

Nor is a change outside an open modal dialog heard. While a dialog opened with `showModal()` is
open, Chromium leaves everything outside the top one out of the accessibility tree, with the
ignored reason `activeModalDialog`, so a screen reader says nothing for a live region there. The
capture reads the open modal dialogs when it observes the change, by the browser's own
`dialog:modal` state, in the document and in every open shadow root. A change is heard only when
it sits inside every open modal dialog on the flat tree walk. Which open modal is on top is not in
the DOM, so with two sibling modals open nothing is heard, while the browser still exposes the top
one. That can only make the capture hear less. A dialog opened with `show()` hides nothing, and
once the modal closes, the content outside it is heard again.

An ARIA modal dialog counts as an open modal too: an element whose first recognized role is
`dialog` or `alertdialog`, with `aria-modal` true, while it is connected and shown. Shown means
rendered and not hidden by `visibility` (`checkVisibility({ visibilityProperty: true })`), and
not under `aria-hidden`, `inert`, or `hidden` on the flat tree. `aria-modal` is read as Chromium
reads an ARIA boolean: true for any value but empty, `undefined`, or `false`, in any ASCII case.
The role and attribute rule is Chromium's `AXObject::IsModal`. Whether content outside such a
dialog is spoken depends on the platform:

- Safari with VoiceOver, on macOS and iOS, hides content outside a shown `aria-modal` dialog.
- Chromium prunes the accessibility tree for `aria-modal` only on Mac and Android
  (`content/renderer/accessibility/render_accessibility_impl.cc` sets
  `SetAriaModalPrunesAXTree(true)` under `BUILDFLAG(IS_MAC) || BUILDFLAG(IS_ANDROID)`; the
  setting is off by default in `third_party/blink/renderer/core/frame/settings.json5`). It
  prunes only while focus is on an element inside the dialog
  (`AXObjectCacheImpl::UpdateActiveAriaModalDialog` and `AncestorAriaModalDialog` in
  `third_party/blink/renderer/modules/accessibility/ax_object_cache_impl.cc`).
- Chromium on Linux and Windows does not prune, so a screen reader there may still speak a
  region outside the dialog.

The capture applies the rule whenever the dialog is shown, wherever focus is. A requirement met
only by a region outside such a dialog fails for VoiceOver users, so hearing it would pass on
words some users never get. Hearing less on the other platforms can only fail a requirement,
never pass one.

The modal state is read again when the announcements are drained. A page can write a region and
open a modal in a later task, before the browser updates the accessibility tree, so a screen
reader likely hears nothing. A change outside a modal open at drain is dropped, so the answer
does not depend on which task ran first. When a modal is open at drain and a recorded change sits
on an element that has left the document, the drain cannot check it and says so
(`changed-element-removed`). A modal dialog inside a closed shadow root cannot be found from the
capture's world. When a flow requirement drains, usabl also reads the document through the
browser's own DOM read over CDP and asks each `dialog` element and each element with
`aria-modal` inside a closed shadow root, in the live world, whether it is an open modal by the
same rule. If one is open, the drain says so (`closed-shadow-modal`). Either way,
the flow requirement emits an `unverified` draft that names the cause instead of a pass or a fail,
unless the focused control's own name is the expected text. A modal inside a frame blocks only
that frame, and frames are not drained, so it changes nothing here.

The capture and the element path function run in isolated worlds, which share the DOM with the
page but not its globals or prototypes. Page script cannot define, replace, or read either one. A
page that defines `window.__usablDrain` or `window.__usablPathFor` before adoption, or replaces
them after load, changes nothing usabl reads, and neither does a page that redefines
`textContent`, `querySelectorAll`, or `CSS.escape` in its own world. The focus and style reads
(`focusBody`, `activeElementIs`, `activeElementWithin`, the focused element behind `activeNode`,
and `getComputedStyle`) run in an isolated world as well, so a page that redefines
`querySelector`, the `activeElement` getter, `contains`, `focus`, or `getComputedStyle` cannot
make a focus check report what it wants. A document where the capture
is not running is an error, which the check runner turns into a coverage gap, never an empty list
of announcements. An element is named by its id only when that id's selector matches exactly the
element in hand, so two ids that escape to one selector, such as a NUL and a literal U+FFFD, give
two identities.

A requirement is matched to the page by `options.screenId`, the surface id the page is. Each
runtime requirement is checked on the page when its surface is the page's surface, and is out
of scope when its surface is another configured or discovered surface and the page's id is a
surface the project or a requirement names. Every other requirement is a `not-covered` gap with
ref `requirement:<id>`: the page is labeled with no known surface, or the requirement names a
surface that matches no configured or discovered surface. A call with no `screenId` is an
unlabeled page. Its findings carry the label `page`, but it counts as no surface, even in a
project that has a surface named `page`, so every runtime requirement is a gap and none is
judged on it. A `screenId` the shared id grammar refuses, such as one with a space or an
invisible character, throws `InputRefusedError` before `checkPage` reads the project or touches
the page. The error names the field and never repeats the id. So a page that regresses on a requirement in the CLI also regresses in
`checkPage` when it is labeled with its surface id, and is `not_covered`, never `verified`,
when it is not.

**The page's address.** A test whose session expired lands on a sign-in page, and the page
handed to `checkPage` is then not the screen it is labeled with. So when `options.screenId`
names a surface that `usabl.config.json` lists, `checkPage` holds the page to that surface's
`url`. The caller can pass `options.expectedUrl` instead, as a full address or a path such as
`/clusters` read against the page's own address. Only the path, with one trailing slash removed,
and the fragment are compared. The origin and the port are set aside, because a test often runs
on its own base URL, on another port, or on `localhost` where the config says `127.0.0.1`. The
query is set aside too, as in the CLI's Rule C. The fragment is compared because a hash router
keeps the whole route there. A hash route, a fragment that starts with `#/`, is read the way a
path is: only the part before its first `?` is compared, with one trailing slash removed, so
`#/clusters?page=2` and `#/clusters/` match `#/clusters`. Any other fragment is compared whole.
An `expectedUrl` that is not an http or https address, such as `about:blank`, is the same
`landing:<screenId>` gap, with a reason that says so, and `checkPage` does not throw. When the
screen declares no readiness signal, `checkPage` first waits for the page to settle, as the CLI
does, and then reads the address. It reads the address again after the checks, and a page that
left its screen while they ran is the same gap, with its findings dropped. A page at another path or fragment is a `not-covered` gap with ref
`landing:<screenId>` that names both addresses, without their credentials, query, or fragment,
and no provider runs. Then the CLI's landing rules A to C from `providers/redirected.ts` are
applied to the page, with the expected address moved onto the page's own origin, so Rule C
compares only the path and the fragment. Rules A and B fire only when the run asserts a session,
because they are claims about a session that was asserted and did not work. A test asserts one
with `options.signedIn: true`, or the CLI's way, with `USABL_STORAGE_STATE` set. A Playwright test
usually signs in through its context's storage state, which usabl cannot see, so it says so with
`signedIn`. Without `signedIn` or the variable, a sign-in page served at the screen's own path,
as a sign-in proxy can serve it, is not caught: the path matches and Rules A and B are off. An adopted page records only the requests sent after `checkPage` was
called, so Rule A sees a refusal only from those, and it is read again after the checks, as in the
CLI. A rule that fires is the same `landing:<screenId>` gap. An unlabeled page, and a page whose id
names no configured surface, claims no address, so it is not held to one unless the caller passes
`expectedUrl`. The address check runs after the readiness wait described next. A page that the
test opened with `setContent` is at `about:blank`, so a labeled one is a gap; serve it at the
screen's address or leave it unlabeled. An in-page anchor changes the fragment, so a page whose
test followed one is a gap until the caller passes `expectedUrl` with that fragment.

When `options.screenId` names a configured surface that declares `reachedWhen`, `checkPage`
holds the page to that signal the way the CLI does, with the CLI's own wait and rule. It waits
for the page to settle and for the selector to match, for at most `signalTimeoutMs` after the
page first settled, within `readyTimeoutMs`. If the selector did not hold, or a declared
response was not seen, the result is a `not-covered` gap with ref `readiness:<screenId>` that
names the part, worded as the CLI words it, and no provider runs. Each part is measured again
after the checks, and a part that no longer holds drops the drafts and becomes the same gap. An
adopted page records only the requests sent after `checkPage` was called, so a response the page
received while it loaded is not seen, and a screen that declares a response is always a gap
here. That screen is checked with the CLI.

### 11.7 Other coding assistants (seam)

The reference integration uses Claude Code's Stop lifecycle event. The architecture does not
depend on Claude specifically. Any assistant that can run a subprocess or call MCP
can integrate the same gate:

| Assistant | Integration shape | What we ship |
|---|---|---|
| **Claude Code** | Stop hook → `usabl check`; mid-task via Bash (built) or MCP wrapper (optional) | Shipped |
| **Cursor** | `usabl install --cursor` writes the stop hook (`hooks.json` plus an adapter script) that loops the agent through Cursor's `followup_message` protocol, the `/usabl-check` command for advisory mid-task scans, and a UI-scoped rule | Shipped |
| **GitHub Copilot** | Extension calls CLI on save or on "agent done" if/when that event exists | Seam documented |
| **Any MCP host** | Optional on-demand tool; gate stays at task-complete lifecycle event | Not built; MCP wrapper is optional |

Implementation is always the same three pieces: (1) detect UI-touching diff or
surface list, (2) invoke `run()` → `Result`, (3) enforce or display per that host's
rules. No second gate, no forked rulepack. A new assistant is a new **surface
adapter**, not a new product.

### 11.8 Later surfaces (documented, not built)

**Storybook addon.** Run `usabl check` per story URL; pairs with discovery item 4
(section 24) that auto-generates surface-map entries from stories. Value: component-level
checks without booting the full app router. Same `Result`, story URL as `screenId`.

Not built. Add only if teams using Storybook ask for it and discovery from routes
is insufficient.

### 11.9 Doctor (onboarding health check, built)

`usabl doctor` is a read-only projection that reports the state of each wired
integration surface. It always exits 0, because a missing surface is information, not a
failure; its filesystem port throws on any write so an accidental write fails loudly. It
reports these surfaces: config, authenticated session, playwright chromium, chromium sandbox,
route manifest, evidence floor, readiness signals, waivers, overlay, stop-hook, the usabl-check
and usabl-fix skills, cursor, ci, branch-rule, workflow owners, and policy scope, each with a state such as wired,
missing, drifted, or unknown. The chromium sandbox surface starts Chromium with its sandbox the way
a scan does, opens one blank page, and closes it. It is wired when that works, missing with the fix
when Chromium reports that it cannot start its sandbox, and unknown when the launch failed for
another reason, such as a missing Chromium. It writes nothing to the repository. The readiness signals surface is missing when a screen holds floored debt and
declares no `reachedWhen` signal, and its next step names those screens. A floored barrier the run
does not see is claimed fixed only with evidence its part of the page rendered: a readiness signal
that held is one way, and a matching element seen on the run is the other (section 9). A docs page
cannot declare a signal, and a surfaces entry with its id is refused, so doctor names docs pages
with floored debt in a note of their own that points to `usabl floor prune --unconfirmed` for a
barrier known to be fixed. The session surface reads the
`USABL_STORAGE_STATE` environment variable, which names a Playwright storage state file, and
when it is unset, the file `usabl session` saved at `.usabl/session/storage-state.json`:
neither is missing, a readable JSON file that still holds something which could authenticate
is wired, and a path that names no file, names a file that is not JSON, or names a state
holding nothing that could authenticate (no unexpired or undated cookie, no local storage,
no IndexedDB, and no stored credential) is drifted. It is also drifted when git would commit
the file (`git ls-files` and `git check-ignore`; a file outside the repository cannot be
committed) or when its group or other permission bits are set, and the next step names every
fix at once: the `.gitignore` line, `git rm --cached`, `chmod 600`, or `usabl session`. Doctor
reads the same expiry rule `usabl check` refuses on, so the two surfaces cannot disagree about
one file. Doctor reports whether a session is set and never prints the variable's path or the
file contents. The saved file's fixed path is printed, because usabl chose it. The CI state is classified by `classifyGateWorkflow`: `missing`, `wired` (two
engine-ref lines, both the same real 40-hex SHA), `unpinned` (both lines are the pin
sentinel), or `drifted` (any other shape). Doctor never mints a verdict or a receipt.

After the surfaces, doctor prints an `optional engines` section (section 7.7). It opens with the line
"Tested against the vendor's documented result format. Not yet run on a licensed SDK. Engine findings
are preview: shown, never blocking." Each engine is `off`, `unknown` when the config cannot be read,
or `on` with its package version (or `package not installed`, with any missing dependency named) and
its credentials state (`credentials: none needed` for Deque, `credentials present: yes` or `no` for
Evinced). The note under each names the next step, or every outside switch that would make a scan
refuse. The section never prints a credential or switch value, and it never changes the surface
counts in the header.

---

## 12. Adoption model

### On or off

usabl is installed (CLI + stop hook + CI + overlay + Reports, one standard) or
the team is not using usabl. Mid-task self-check uses the CLI; an MCP wrapper is
optional. There is no "partial" mode and no per-surface strictness.

Onboarding uses two distinct commands. `usabl init` scaffolds policy: it writes
`usabl.config.json` and `usabl.routes.json` only (never the evidence floor or waivers)
and refuses to overwrite without `--force`. `usabl install <target>` wires integrations,
exactly one per run: `--overlay` (the Vite or webpack plugin; see section 11.3), `--claude` (a Stop hook running `npm exec --no -- usabl
stop-hook` in `.claude/settings.json`), `--ci` (the generated PR-gate workflow), or
`--branch-rule` (a read-only check that the protected branch requires the `usabl-required`
status check and review from code owners, which prints the setting and the `CODEOWNERS` lines
for `.github/workflows/` and the guarded paths). `init` does not wire CI or overlays, and `install` does not
scaffold policy.

`usabl init` looks for the router in `src/App.tsx`, `src/App.jsx`, `src/routes.tsx`,
`src/router.tsx`, `src/app/routes.tsx`, and `src/app/routes.jsx`, in that order, under the app
folder (below), and takes the first that holds route code. It reads routes from it as described
in [Reading routes out of router source](#reading-routes-out-of-router-source). The draft's
`wideBlastGlobs` list the router file and whichever of `src/main.tsx`, `src/main.ts`,
`src/index.tsx`, `src/App.tsx`, `src/App.jsx`, `index.html`, `src/index.html`, the Vite config (any of `vite.config.ts`, `.js`, `.mts`, `.mjs`, `.cts`, or `.cjs`), and
the CSS files under `src/` exist in the app folder, because a change to any of them can reach
every screen. To attribute a route import written through an alias, `init` reads the
`tsconfig.json`, `tsconfig.app.json`, and Vite config in the app folder only. A route whose
import goes through an alias set anywhere else stays unattributed, which `init` counts in its
report; it does not guess the entry file.

**Which app `init` drafts.** `usabl init --app <dir>` drafts the app in that folder, written
relative to the repository root, such as `usabl init --app packages/web`. A folder outside the
repository, one with no files, and one written with a glob character (`*`, `?`, `[`, `]`, `{`,
`}`, or `!`) are refused, because a glob could name several apps at once. A folder written
inside the repository whose real path, through symbolic links, is outside it is refused too,
with exit 2, because its draft would check files the repository does not hold. With no flag, `init`
drafts the root app when the root has a Vite config, a router file, or `src/**/*.tsx` or
`src/**/*.jsx` files. Otherwise it
looks below the root: a folder with a Vite config two levels down anywhere, or three under
`packages/` or `apps/`, and a folder under `packages/` or `apps/` with a router file. It skips
`node_modules`, `dist`, `build`, `coverage`, and hidden folders. When it finds one app, it drafts
that app and says so in a `Review:` note. When it finds more than one, it refuses, writes
nothing, lists every app it found, sorted, and names the `--app` flag to use, because a config
drafted for the wrong app checks the wrong files. With `--app`, when `init` finds other apps the
same way, a `Review:` note says the config checks only that app and names the others, sorted.

Every path `init` writes stays relative to the repository root: `uiFileGlobs`, the router file,
`wideBlastGlobs`, and each entry file carry the app folder, such as `packages/web/src/**/*.tsx`.
`usabl.config.json` and `usabl.routes.json` are written at the root, and `guardedPaths` names
them there, so CODEOWNERS and the trusted-ref guard still match them. A config drafted for one
app treats a change in another app as no UI change. A workspace package the app depends on is
different, because the app may render components from it. When the app's `package.json` depends
on a package found under `packages/` or `apps/`, or in a folder the root `workspaces` field or
`pnpm-workspace.yaml` lists, a `Review:` note names it and says to add its
files to `uiFileGlobs`. `init` does not add them itself, because it cannot tell which of the
package's files the app renders.

**Workspace packages at check time.** `check` does not rely on that note. When the root
`package.json` declares `workspaces` (a list, or Yarn's `{ "packages": [...] }`), or
`pnpm-workspace.yaml` lists `packages`, the planner reads every pattern, with `!` patterns
excluded, and each workspace package's `package.json`. The configured app is the package the
router file, the `uiFileGlobs` folders, and the surface files sit in, which is the root package
for a root app. A changed file in a workspace package the app depends on, directly or through
another workspace package, is a `not-covered` gap and an unmapped file when it is outside
`uiFileGlobs`. A package depends on another when any of these holds:

- Its `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies` name it,
  by key, or by an alias value: `workspace:<name>@<range>`, `npm:<name>@<range>`, or a
  `file:`, `link:`, `portal:`, or `workspace:` path that points at its folder, read from the
  declaring package's folder.
- One of its source files names it, or a subpath of it, as a quoted module specifier. npm,
  Yarn classic, and Bun hoisting let a package import another it does not list. Any quoted
  match counts, on one line or several, so the check can over-count but not miss an import
  written in source. A source file that cannot be read counts every package.
- A path alias in its own `tsconfig.json`, `tsconfig.app.json`, or Vite config, or in the
  repository root's, points into its folder.

The source and alias checks run only for a package that leaves a changed package unreached by
its declarations. The gap names the package and the fix: add the package's source to
`uiFileGlobs` and list the file in the files of each surface that renders it. Test files and
Markdown files are left out, as are files in the app's own package. Leaving Markdown out is an
accepted miss: a package can ship Markdown the app renders, and a change to it reads as nothing
to check. A workspace package that declares its own `workspaces` is not read as a nested root. A package whose
`package.json` cannot be read counts as one the app depends on. A file belongs to the deepest
workspace package folder it sits in. A change in a package the app does not depend on, and any
change in a repository with no workspaces, reads as before.

When the root `package.json` or `pnpm-workspace.yaml` exists and does not parse, or holds its
workspace field in a shape no package manager reads, the workspace packages are unknown. Every
changed file that is not a test, not UI, and not Markdown is then a `not-covered` gap whose
reason names the file usabl could not read. A workspace pattern with `..` in a brace group is
refused, and a glob result that is absolute or leaves the repository is never read.

The workspace patterns and every package's dependencies are read from the trusted ref as well
as from the tree, and the union counts. A change that removes `workspaces` from the root
`package.json`, or the app's dependency on a package, in the same change that edits the
package, still gaps that edit. A `package.json` the trusted ref does not have adds nothing, and
a trusted root manifest that does not parse makes every such file a gap.

The change is not mapped to screens through imports. The import graph follows relative and alias
imports only. A package import resolves through the package's own manifest, its `exports`
conditions and `main` field, often to built output that is not in the repository, so usabl
cannot resolve it soundly from source, and a wrong guess would scan fewer screens than render the
change while the run reads as covered.

**The dev server URL.** `init` parses the app's Vite config, without running it, and reads
`server.port` and `server.https` from the exported config: `export default { ... }`,
`defineConfig({ ... })`, a function that returns the config, or a `const` that holds one. The
port counts when it is a number literal. https counts when `server.https` is `true` or an options
object, or when the plugins list calls `basicSsl()`. A setting that is absent takes Vite's
default, port 5173 over http. A setting written as code, such as `Number(process.env.PORT)`, or a
`server` block it cannot see into, such as a spread or a variable, is never guessed: `init` uses
the default and a `Review:` note names the setting it could not read and says to set
`appBaseUrl` by hand. A port in another block, such as `preview.port`, or in a comment or a
string, is never read as the dev server port.

**Drafts that would read as idle.** A config with empty `uiFileGlobs` treats no change as a UI
change, so every run reads as nothing to check and no run can ever produce a verdict. `init`
drafts `src/**/*.tsx` and `src/**/*.jsx` under the app folder when those files exist. When
neither exists, it refuses, writes nothing, and says to use `--app` or to set `uiFileGlobs` by
hand. When it derives no route at all, it writes `usabl.config.json` but not
`usabl.routes.json`, because an empty sidecar takes precedence over the router and lists no
screens. It says so and points to the manual mapping: a surface in `surfaces` with its id, url,
and files, or routes written into `usabl.routes.json`. Until then a changed UI file is
reported as not covered. When no route is derived and a `usabl.routes.json` already exists,
`init` refuses even with `--force` and writes nothing, because usabl reads that sidecar instead
of the router: the new config would be checked against routes `init` did not derive, possibly
another app's after `--app` names a different folder. The refusal names the file to review, and
says to delete it and run `init --force` again if it does not list this app's screens.

A config with empty `uiFileGlobs`, such as one written by hand or by an older `init`, is
refused on every path that reads a config to decide what to check. One rule decides it, and
each path prints the same sentence, which says why and names the fix:

- The CLI's config loader. `usabl check` and every other command that loads the config file
  through it, the dev-server overlay included, stop with exit 4 before they run, the same way
  they stop on any other config error.
- The CI judge, `check --ci --trusted-ref <ref> --isolated-browser`. It reads the config at the
  trusted ref and never calls the loader, so it applies the rule itself, with exit 4.
- The Stop hook. It never says idle for such a config. It blocks the stop as approval
  required, as it does for a config that does not parse, and lets one continuation through.
- `usabl doctor` reports the config as drifted, with the same sentence as its next step.

A documentation-only repository has no UI files, so the config loads when `usabl.docs.json`
loads and names at least one page: the docs manifest says what to check. A manifest that is
only there, with no pages or that does not load, does not count. Each path reads the manifest
from where it reads policy: the folder usabl runs in for the loader and doctor, the trusted ref
for the CI judge, and the repository root for the Stop hook. The Playwright helper reads the
config only for its design requirements and checks the one page a test hands it, so a run of
it never reads as idle and it does not apply this rule.

### Brownfield adoption (prove what you touch)

A team in year four of a 400-screen console adopts usabl on Monday without mapping 400
screens on Monday.

1. Install usabl (on): CLI, stop hook, CI, overlay, Reports. One standard.
2. Optional first step: `usabl check` on a surface to see findings and accept an
   evidence floor before the stop hook blocks anyone.
3. Most PRs that do not touch UI: non-blocking "nothing to check" outcome.
4. First UI PR on a page discovery cannot map: `not_covered` until a surface map
   entry or a parseable route exists. Pages the router already lists do not need a
   hand-written map entry.
5. First check of that page: likely a pile of existing findings. A code owner accepts
   the evidence floor (and maybe a few waivers). That is one `approval_required` commit.
6. Next PR on that page: full default stack. A problem at an identity the floor does not
   hold, or above the count it recorded there, blocks. Recorded ones stay visible debt. A
   fix that two scans of main confirm closes its slot on its own (see Debt history in
   section 9); the committed floor comes down only through `usabl floor prune` or a new
   baseline. A waiver becomes inert on its expiry date and never edits the floor.

Coverage grows as the team works. It does not require Design to declare epic scope.

### Ratchet

Same full check every time. Existing findings are the floor. New findings are
regressions. The committed floor changes only when `usabl floor prune` writes a new one
after a clean scan observed fewer barriers, or when `usabl baseline` re-drafts it under
review, and it never silently grows. What a run accepts can only shrink without review:
once two scans of main confirm a fix, the debt history lowers the accepted count for that
identity (section 9). Accepting new debt stays human.

### Waivers

One finding, owned, expiring. Not "this page is advisory." Required fields: rule,
surface, scope, owner, reason, approvedBy, created, expires. An expired waiver is inert:
the finding is then carried if the evidence floor holds its identity, and blocks only if
it is new against the floor.

### What adoption is NOT

- Per-surface severity dials.
- "Legacy surfaces are exempt from checks until a team claims them."
- Design declaring in-scope epics or journeys.
- A way to make usabl quieter on some screens.

---

## 13. Design intake

### What Design/UX sends

Design adds intent the engine cannot infer. It does not restate WCAG or PatternFly
rules (those are built in). It does not set enforcement level.

| Kind | Example | Runtime effect |
|---|---|---|
| `content` | Alt text for topology.svg must be "Cluster network topology showing three nodes" | Content matcher assertion on that element |
| `flow` | After failed save, error is announced before focus moves | Declarative interaction script added to the walk |
| `doc` | Publish alt-text manifest for the Clusters surface | Output module generates the artifact |
| `voice` | Deleting a row announces the deletion | Interaction contract run by the virtual screen reader provider (section 7.5) |
| `name` | A button is named "Refresh" | Exactly one element with that role and accessible name (section 13.1) |
| `heading` | The heading "Users" is level 1 | One heading with that name, at that level |
| `landmark` | The screen has a main landmark | The landmark exists, by role and, when given, name |
| `focus-order` | Focus reaches "Create user", then "Refresh" | A Tab walk from the top of the page reaches the names in that order |
| `target-size` | The "Refresh" button is at least 24 CSS pixels | The laid-out size of that one element |

### Many shapes in, one RequirementBundle

```
Figma file ──────> usabl import figma ──> YAML in repo ──> normalize() ──> RequirementBundle
YAML by hand ──────────────────────────────────┘
```

The normalizer produces one `RequirementBundle` from the YAML files in the requirements folder.
Hand-authored YAML is one source. `usabl import figma` (section 13.2) writes YAML from the
accessibility stamps in a Figma file, and that YAML goes through the same loader and the same
review as any other.

### Guarded

Requirement files are guarded paths. Changing them triggers `approval_required`. Design
cannot weaken checks; only engineering + code owners change rule modules. Design can
add content and flow assertions that the engine enforces alongside the default stack.

### Mapping to checks

- `content` requirements become content-matcher providers (compare element text or
  aria-label against the approved string).
- `flow` requirements become declarative interaction probes (same step runner as the
  keyboard walk probes). The silent change rule watches their click and activate steps
  (section 7.5.1). A flow with a step the driver cannot run, such as a click with no selector,
  runs none of its steps and is a `not-covered` gap that names the step (section 7.5.1). Its
  verdict reads only what was announced after its first step ran.
- `doc` requirements are not runtime checks; they feed the output module.
- `voice` requirements become interaction contracts, one virtual screen reader provider each
  (section 7.5).

A `voice` requirement looks like this:

```yaml
version: 1
requirements:
  - id: delete-row-announces
    kind: voice
    surface: clusters
    description: Deleting a row announces the deletion
    approved: true
    assertion:
      type: voice
      steps:
        - do: click
          selector: '[data-row="a"] button[aria-label="Delete"]'
      obligations:
        - class: live-polite
          afterStep: 0
          requiredTokens: [deleted]
          mustAnnounce: true
      maxTabPath: 20   # optional
```

The requirement id becomes the contract id, the surface the contract surface, and the
description the contract task. A step is `tab`, `activate` (Enter), `press` with a `key`, or
`click` with a `selector`, and takes no other field. Each obligation names a `class`, the step
window it is checked in (`afterStep`), the `requiredTokens` the announcement must hold, an
optional `focusedRole`, and `mustAnnounce`. `class` and `focusedRole` are stored trimmed.
Parsing refuses the file, as `approval_required` with a message that names the field and what
to write, when: `steps` is empty; a step is another kind, a `press` has no key, a `click` has no
selector, or a step has a field it does not use; `obligations` is empty; an `afterStep` is not a
whole number from 0 to one less than the number of steps; `requiredTokens` is empty, or a token
has no letter or digit in any script, because such a token compares as empty and would match
any announcement; `class` is empty after trimming; `focusedRole` is not a string or is empty
after trimming; `maxTabPath` is not a positive whole number; `kind` does not match
`assertion.type`; or any field is unknown.

A requirement of any kind but `doc` runs only on a screen whose id is its surface. When a run
scans anything, each such requirement whose surface matches no configured surface, no screen
in the route manifest, and no page in the docs manifest becomes a `not-covered` gap with ref
`requirement:<id>` that names the surface. No run would ever plan that screen, so nothing
checks the requirement, and a misspelled surface would otherwise turn it off while the run
read as verified. A requirement on a known screen that the change did not touch is out of
scope for that run, not a gap. The surfaces are read through the same trusted view the run
plans coverage with. `checkPage` applies the same rule through the same code.

Drafts of an approved content, flow, name, heading, landmark, focus order, or target size
requirement carry `evidenceClass: 'deterministic'` (the assertion is hard and repeatable).
`mapRequirementsToProviders` emits them with rule id `intake:<id>`; there is no code path that
marks an intake draft as model-judgment. Voice requirement drafts carry the `voicing/` rule ids of
the two tiers, with the requirement in place of `voicing/`, and are `preview` unless their
obligation class is promoted (section 7.5). A flow or voice provider can also return
`voicing/silent-change` drafts, which are always `preview` (section 7.5.1).

**Approval.** A requirement with `approved: false` never blocks, whatever its kind. This is a
change in 0.3.0: before it, `approved` was not read on the check path, so a content, flow, or voice
requirement with `approved: false` blocked like an approved one, and a check of it that could not
run was a coverage gap. A run that was `regression` or `not_covered` only because of such a
requirement now reads `verified`. Its provider
runs, and every draft it returns is `preview`, with a sentence that says the requirement is not
approved yet. A check that returns a gap, or that throws, is shown as one `preview` draft that
gives the reason, so an unapproved requirement cannot hold a run at `not_covered` either. A
thrown provider keeps the partial drafts that were already `preview`. This is done where the
providers are built (`src/intake/requirement-approval.ts`), not in the gate: the gate already
ignores `preview`. Two gaps still apply to an unapproved requirement, because they say nothing
checked it: a surface that matches no known screen (above), and a capability the run did not
grant. Approving a requirement is a change to a guarded file, so it needs owner review.

### 13.1 Design checks: name, heading, landmark, focus order, target size

These five kinds find an element the way a screen reader user does: by role and accessible name.
A requirement never holds a CSS selector. The roles are `button`, `link`, `heading`, `img`,
`textbox`, `checkbox`, `menuitem`, `tab`, and the landmark roles `main`, `navigation`, `banner`,
`contentinfo`, `complementary`, `region`, `search`, and `form`.

```yaml
  - id: users-refresh-name
    kind: name
    surface: users
    description: The icon button is named "Refresh", as in the design.
    approved: true
    assertion: { type: name, target: { role: button, name: Refresh } }
    source: { tool: figma, file: AbC123, node: "2:7", version: "4242" }
```

The other assertions are `{ type: heading, name, level }` with a level from 1 to 6;
`{ type: landmark, role, name? }`; `{ type: focus-order, sequence: [name, ...] }` with 2 to 200
names; and `{ type: target-size, target: { role, name }, minCssPx }` with a size above 0 and up
to 200. Names are stored the way the browser reports an accessible name: each run of ASCII white
space is one space, with none at either end, and they are compared with the page's names the same
way, so "Create  user" matches "Create user". Case and every other character must match. The
loader refuses, as `approval_required`, an empty name, a
heading level that is not a whole number from 1 to 6, a focus order that repeats a name, an
unknown role, an unknown field, and a `source` whose file key, node id, or version does not fit
its grammar.

**How the element is found.** For each role usabl queries a fixed CSS list of the elements that
can have it (for a button: `button`, `[role~="button"]`, button-type inputs, and so on). A role
attribute is matched by token, because the browser uses the first role token it knows, so
`role="button menuitem"` is a candidate. usabl reads each candidate's role and computed name from
Chromium's accessibility tree, and keeps the ones whose role matches and whose name equals the
requirement's name once white space is collapsed on both: each run of ASCII white space (tab, line
feed, form feed, carriage return, space) is one space, and none is left at either end. Any other
character, a no-break space too, is part of the name. The focus order check reads names by the
same rule. It then compares how many candidates the page has in all,
inside open shadow roots and in every frame too, with how many it read. Last, it counts the nodes
of the page's whole accessibility tree that are not ignored and have the role and the name. The
browser builds that tree from every role source, so it also sees an element in a closed shadow
root, a role set by script through ElementInternals, and a candidate whose own read came back
empty. When the tree has two or more, the answer is more than one match. When its count differs
from the document search, the tree has more than 20000 nodes, or the browser's answer holds no list
of nodes (the field is missing or is not a list), usabl cannot tell. The search
gives one of five answers: one match, no match, more than one match, some candidates out of reach,
or cannot tell. Only "one match" is used as the element. Two matches is never resolved by picking
the first: a wrong guess is reported as unknown, never as a finding or a pass. A landmark
requirement with no name that the document search does not find is unknown, not missing, when the
tree has a landmark of that role or has more than 20000 nodes. The tree does not cover child
frames; the frame count above does. Known limit: an element in a closed shadow root inside a child
frame is seen by neither count. The frame count reads only open shadow roots, and the tree covers
only the main frame. So on a page with child frames, a second match there goes unseen, and the one
match usabl reads can count as the only one.

**How the tree is read.** The design checks read the whole tree with one
`Accessibility.getFullAXTree` call. The read has no time limit and no timer, so no clock decides a
design check. Its only bound is the node count: a tree with more than 20000 nodes is not read, and
each check that needs it is needs review with a reason that names the limit. An answer with no
list of nodes is not read as a tree with no nodes: it is unreadable, and each check that needs it
is needs review with a reason that says so. A read that never returns is bounded by nothing in
usabl. In CI, the job's own time limit ends it (a workflow that `usabl install --ci` writes sets
none, so GitHub's default applies), and the job is cancelled, so the required check is not green.
In the Stop hook, the agent's hook timeout ends it with no verdict. It never reads as a pass.
Measured in Chromium,
the largest fixture page returns 172 nodes, and the `usabl-app` screens measured for the silent
change rule return 179 to 300. The read keeps the same nodes as the silent change rule's read but
reads no sort state, which no design check uses. It is read once per page state: every design
check on a screen shares one read. The focus order check, which presses Tab, and the target size
check, which scrolls, each drop it when they end, so the next check reads the page again. The silent change rule keeps its own read, with its
500 ms and 5000 node budget.

**What each check reports.** A check that passes returns no draft. Each failure and each unknown
is one draft with rule `intake:<id>`, a layer per kind (`intake-name`, `intake-heading`,
`intake-landmark`, `intake-focus-order`, `intake-target-size`), and the screen as its element.

| Kind | Fails (`confidence: 'fail'`) | Unknown (`confidence: 'unverified'`, needs review) |
|---|---|---|
| `name` | No element has that role and name, and none has it once all white space is collapsed | More than one does, a candidate is out of reach, usabl cannot tell, or no element has the name but one has it once all white space is collapsed (the reason names the character and where it is) |
| `heading` | No heading has that name, or it has another level | More than one does, a candidate is out of reach, usabl cannot tell, or its level cannot be read |
| `landmark` | No landmark of that role (and name, when given) | A named landmark matches more than once, a candidate is out of reach, or usabl cannot tell; with no name, none is found and a candidate is out of reach, the tree has one, or the tree has more than 20000 nodes |
| `focus-order` | A name is never reached, or two names are reached out of order, in a walk whose end was confirmed | A name is on more than one stop, a stop cannot be read, the walk hits its cap of 200 stops, or the walk was cut short |
| `target-size` | The element is smaller than the size in either direction | No element, more than one, a candidate is out of reach, usabl cannot tell, its size cannot be read, or it has a shape usabl does not measure (below) |

A missing element is unknown for `target-size`, not a failure, because the check is about size and
the size of nothing cannot be measured. The `name` check reports the same missing element as a
failure, with one exception. When no element has the name, but one has it once white space of any
kind is collapsed and trimmed on both sides, the check is needs review, never a failure, because a
person looking at the page sees the name the design gives. The reason names the character and
where it sits, for example: a button on this screen is named "Refresh" followed by a no-break
space.

The focus order check presses Tab from the top of the page and uses the keyboard walk's end rule,
from the same code (`src/providers/keyboard-walk/walk-end.ts`). When focus reaches the body, it
presses Tab once more. The walk is complete only when that Tab lands on a stop it already walked,
matched by element when the browser gives a node id for both and by path otherwise, or stays on the
body when no stop was walked. Then focus goes back to the body. A walk that ends any other way was
cut short, and the check is unknown, never a failure: a handler that blurs a control or stops Tab
(the extra Tab lands on a new control, or focus stays on the body), and focus that comes back to a
stop it already walked without passing the body (a focus trap, or a list that rendered again with
no node id to tell the elements apart). With node ids, a new element at a walked path is a new stop,
and the walk goes on. The check needs the page as it loaded: it is skipped as a gap if a check that
changes the page ran first, the same as the keyboard walk. The target size check reads the
element's laid-out border box with `getBoundingClientRect` in an isolated world, and compares the
size as read; the message shows it to one decimal, rounded down, so 23.95 reads as 23.9 and never
as 24. It measures only the border box of an element laid out in one box, when none of the
shapes below holds. Each of them is unknown (needs review, with the reason), never a pass, because
the box it reads can be larger than the area a pointer can hit:

- the element is laid out in more than one box, such as an inline link that wraps onto two lines
  (`getClientRects` gives more than one);
- the element, or an element above it, has a transform that rotates or skews it, or a `rotate`
  value: a computed `transform` matrix with a nonzero `b` or `c`, a `matrix3d` that is not a 2D
  scale and translate, or one usabl cannot parse. A translate, a scale, or both is measured;
- the element, or an element above it, has a `clip-path`, a `clip`, or a mask image;
- an element above it has overflow other than visible on an axis (hidden, clip, auto, scroll, or
  overlay), or a `contain` value that holds paint, and the element reaches past that element's
  padding box on that axis, so only part of it can be on screen at once. On the root and the
  body, only hidden and clip count, because their scrolling is the viewport's;
- the element, or an element above it, is fixed or sticky, and the element reaches past the
  viewport;
- the walk up passes 512 elements;
- bringing the control fully into view needs a scroll of an element above whose overflow is
  hidden or clip on that axis, or of the window while the root or the body hides overflow on that
  axis. A person cannot make that scroll, so what it shows is not what a pointer user meets. This
  counts as the overflow limit. Before the hit test, usabl first scrolls with `nearest`, which moves
  a box only when the control is not fully inside its scrollport, and judges only that scroll; the
  centered scroll after it is not judged, so a fully visible control that is not centered in such
  a box, as in a carousel, is not counted. Each overflow value is read before any scroll, and a
  value usabl does not know counts as hidden;
- the hit test misses (below);
- the box read again after the scroll into view differs from the first read in width or height by
  more than 0.01 pixels, so the size that was measured may not be the size a person meets, for
  example under a scroll-driven animation.

The walk up follows the flat tree, through slots and out of shadow roots, and skips inline
elements and elements with no box for overflow. A fixed element that escapes an ancestor that
clips is still read as clipped, which only ever asks for review. The box read and the check share
one list of limit names (`src/primitives/box-limits.ts`), and the check asks for review whenever
the read names any limit, even one it has no words for.

The list above cannot name every shape, so a pass also needs a hit test, read last in the same
browser function. usabl scrolls the control into view (centered, with instant scrolling), then
puts every box, and the window, back where it was on each axis a person cannot scroll (overflow
hidden or clip, or a value usabl cannot read), so the points are read only at a position a person
can bring the control to. It reads the box again, and asks `document.elementFromPoint` what is at five points: the center, and the
middle of each edge, 1 CSS pixel in. Edge middles are used, not corners, so a round or
pill-shaped control is not flagged. A point is a hit only when the answer is the control or an
element inside it; an answer of null, outside the viewport, is a miss. Any miss is needs review,
with the reason that part of the control's box cannot be hit: something clips it or covers it, it
does not take pointer events, or it is partly off the page. The real-browser tests in
`test/intake/roles.real.integration.test.ts` hold that each of these is needs review, with a box
large enough to pass: a clipping element that is itself scaled, or sits inside a scaled element
(no named shape sees either); `content-visibility: auto` on a short element above; a control
partly left of the page; `pointer-events: none`; and a control half covered by another element.
They also hold that a button below a scaled box that hides its overflow, shown only by the read's
own scroll, is needs review, and that a plain button, a round one, one in a box that scrolls
without cutting it off, and one far down a long page still pass. A button past the bottom of a box
that scrolls is needs review already, through the overflow limit read before the scroll. Before
the function returns, it puts back the scroll position of the window and of each element on the
walk up whose position changed. It has no timer and does not wait. The size it reports is the
first read, before the scroll. A pass proves that the box is large enough and that these five
points land on the control. A cover or clip anywhere else, at a corner or between the points, is
not seen, so such a control can still pass. The check does not measure the spacing between
targets. A target size check drops the design checks' shared tree read when it ends, as the focus
order check does, because page script can answer its scroll by changing the page.

The check measures the control alone: a label that makes the real target larger, such as the
label of a checkbox, is not counted, so a small checkbox can fail although its real target is
larger. The importer drafts target size checks for buttons only.

These checks cover the sizes, names, and order that a design states. They do not check every
control on the page. axe's own `target-size` rule is a separate question: it runs in the docs
profile, and it does not run in the app profile (see the WCAG table, 2.5.8).

### 13.2 Design input from Figma

`usabl import figma <file key> --frame <Frame name>=<surface id> [--frame ...] --out <file>
[--owner <name>] [--min-target <css px>]` reads one Figma file with `GET /v1/files/<key>` and
writes a new requirements file. It reads accessibility annotation stamps: component instances
whose component name ends in "Stamp" or "Details", placed over the design element they describe. A
stamp is linked to the element whose own area it covers most, preferring text, with ties broken by
document order. The element's text is the accessible name, except for a Button stamp, whose name
comes from the Button Details card with the same note number.

- A Heading stamp with level h1 to h6 gives a `heading` requirement.
- A Landmark stamp gives a `landmark` requirement.
- A Button stamp with a Button Details card gives a `name` requirement, and, with `--min-target`, a
  `target-size` requirement at that size.
- Two or more Ordering stamps, each with its own whole number and its own name, give one
  `focus-order` requirement per frame.

Every note it cannot turn into a check is printed with the reason and left out of the file: a speech
note, an image stamp, any other kind of kit note, a Dev Mode note, a relative heading level, an
ordering stamp with no number, a card that matches no stamp, a card whose name is a slot, a name
that is empty, longer than 200 characters, or that the scrubber would change. Nothing is dropped
without a line.

Each requirement is written with `approved: false`, an id `figma-<surface>-<kind>-<n>`, the
`--owner` value, and a `source` with the file key, the stamp's node id, and the file version. The
command checks that the text it is about to write loads through the normal loader with every
requirement unapproved, and writes it with an exclusive create, so it never overwrites a file. It
refuses an unknown option, a frame given twice, a frame the file does not have, and an id a
surface cannot have, before it writes anything. It exits 0 when it wrote the file and 2 otherwise.
Both commands read an answer from Figma up to 256 MiB; an answer that states or reaches a larger
size is a fetch failure that says so. The cap bounds the size of the answer, not peak memory:
reading, joining, decoding, and parsing one answer under the cap can need several times its size.

`usabl drift design` loads the requirements, keeps the approved ones that have a `source`, and reads
the current version of each of their files, once per file, in sorted order. It lists the
requirements whose recorded version differs from the current one, grouped by file and recorded
version, and says when a requirement's node is no longer in the file. Unapproved drafts are left
out. With no `requirements` path in the config, it says no requirements folder is configured and
exits 0 without a network call. It exits 0 with no drift, 1 with drift, and 2 when it could not check: a missing token, a
refused address, any fetch failure, or a file it has no version for. Exit 2 always says "Design
drift was not checked." and never reads as no drift. It compares whole-file versions, so a change
anywhere in a file lists every approved requirement drafted from that version.

Both commands read the token from `FIGMA_TOKEN` only, never print it, and send it only in the
`X-Figma-Token` header to `https://api.figma.com`, or to `FIGMA_API_BASE` when that is https or
loopback http. They do not follow redirects. Both are loaded by a dynamic import inside their own
command, and a test pins that no check, gate, or hook entry point can reach their code
(threat model, Threat 18).

A component property can be a slot, whose value is an id object, not text. The reader accepts a
file that uses one, and a slot property never reads as text. A Button Details card whose
Accessible Name is a slot, or is empty, is listed with the reason. When no other card with its note
number has a name usabl can read, the Button stamp with that number is listed too, and so is an
Ordering stamp on the same element: the layer text is never used in place of the name the card
was meant to give. When a readable card and an unreadable card share a note number, which name the
designer meant is a guess, so no requirement is drafted from either: both cards are listed, and so
are the Button stamp with that number and an Ordering stamp on the same element, whichever card
comes first in the layers.

A name is copied from design text after the characters that make a display lie are removed, and
with the white space rule the page match uses: each run of ASCII white space is one space, with
none at either end. A no-break space stays where it is, as the page keeps it. Text that is only
white space, of any kind, is no name.

This was tested end to end with a mock file written by hand to match Figma's published file
format; not yet run on a real design file. The local Figma types are written the same way, and
nothing in the repository checks them against Figma's own package yet.

### Requirement ids are waiver identities

A requirement id becomes the rule `intake:<id>`, and a waiver matches on that rule plus the
surface. Two requirements that share an id therefore share a rule, and one waiver would cover
a requirement its author never saw. The loader refuses a repeated id across every requirement
file at once, since each file can be valid on its own, and names both files and both list
positions. A requirement id, and the surface it names, follow the same character grammar as a
surface id (section 22). A refused character is reported by position and code point, never
printed back. Either failure is `approval_required`, returned from the loader rather than
thrown, and every reason the loader returns is scrubbed before it leaves, including the file
path, because it can carry file bytes. A YAML syntax error names the file, the line, and the
parser's problem, such as `intake YAML is invalid at line 5: unexpected end of the stream within
a flow collection`. The parser's own message is never used, because it quotes the source line,
and a problem that carries source text after its fixed wording, such as an alias name, is cut
before that text.

Any loader failure stops every scan, and the run shows the loader's reason as a `not-covered`
coverage gap whose ref is the refused file, or the configured root when the loader named none.
So a broken requirements file is visible on every surface. When a UI file changed, the
accessibility half of the Result reads `not_covered` rather than `verified`, because no screen
was scanned.

---

## 14. Reports (accessible docs output)

The deck calls this surface "Reports." It is distinct from documentation checking
(sections 3, 7.6, 8): checking scans product docs for barriers, while Reports generates
publishable accessibility artifacts from an already-verified run. The command is
`usabl docs`.

### What it generates

After a verified run, produce published documentation from verified evidence plus
approved content requirements:

- **Alt-text manifest:** element, approved text, status (draft/approved), evidence link.
- **Announcement snippets:** per surface, what a screen reader would announce at each
  interactive stop.
- **Keyboard paths:** the Tab order through each surface with the announcement at each
  stop.

### AI drafts, humans approve

AI can propose alt text or doc copy. usabl publishes only entries with
`status: 'approved'`. Draft entries are visible but clearly labeled.

### Bound to evidence

Each DocArtifact is bound to the code state via `boundToReceipt`, and records the git tree
it was made from in `sourceTree`: the receipt's tree when the run minted one, otherwise the
tree `usabl docs` read before the run. A report is marked stale wherever it is listed or read
against a tree other than its own, and also when it records no tree or the current tree cannot
be read: the artifact gets `stale: true` and a `staleReason` that names both trees and says to
run `usabl docs` again. `usabl docs` reads the tree before and after the run, so a file saved
while the scan ran marks the report stale in its JSON and on its `--html` page, with or without
a receipt. A run whose files changed during the scan is not covered and mints no receipt, so
the report records the tree read before, and the tree read after differs from it. A receipt
binds the tree the run read before it planned. If that differs from the tree `usabl docs` read
before the run, the report also records the earlier tree in `startTree`, and a report whose two
trees differ is stale against every tree, the receipt's tree included. On the page a stale
card reads "Out of date", never "Verified", and the overview counts the stale cards. A report
saved earlier and read again is checked with `markStaleDocArtifacts(artifacts, currentTree)`
from `usabl/docs`. All of these use one check, `markStale` in `src/docs/evidence-binding.ts`.
No usabl command reads a saved report back; a static HTML page saved to disk cannot mark
itself, so regenerate a page before publishing it.

The tree is the working tree as git would commit it with everything added: usabl builds a
temporary index from `git read-tree HEAD`, runs `git add -A` into it, and runs `git write-tree`
(`writeTree` in `src/deps/git.ts`, the same function the receipt uses). So staged, unstaged, and
untracked edits all change it. A caller of `markStaleDocArtifacts` must compute `currentTree`
the same way, with `GIT_INDEX_FILE` set to a temporary file for all three commands. A plain
`git write-tree` reads the real index, and `HEAD^{tree}` leaves out every edit not committed, so
with a dirty work tree either gives another tree and every report reads as stale. That fails
safe, but no report ever reads as current. `git add -A` skips files git ignores, so an edit to an ignored file, such
as a generated asset the app serves, does not change the tree and does not mark a report stale.

### How to run it

`usabl docs` runs a full check and prints an `{ artifacts: [...] }` JSON envelope on
stdout, or, with `--html`, renders the same artifacts as one accessible, self-contained
HTML page. It is a generator, not a gate: it always exits 0 and never mints a verdict.
Announcement snippets and keyboard paths come from the run transcript; the alt-text
manifest comes from configured content requirements. Surfaces the run did not verify
carry no `evidenceRef`, so unverified state cannot masquerade as proof. The same
projection is available to library callers as `projectDocs` and `collectDocArtifacts`
from the `usabl/docs` export.

By default `usabl docs` documents the surfaces the working-tree change touched, the same
scope `usabl check` uses, so a clean tree yields an empty `artifacts` list. `usabl docs
--all` documents every in-scope surface instead. It plans the run from every file the
`uiFileGlobs` match, every file a surface names, and every source of a docs page, so every
screen the planners can reach is scanned, whatever git status says. Nothing else about
coverage changes: a file no screen owns is still a coverage gap, and that gap still stops
the run from minting a receipt. It is still a generator. It exits 0, mints no verdict of
its own, and takes every honesty state from receipt binding, exactly as the per-change
mode does. In practice that means `--all` mints no receipt in most apps: one UI file that no
route or surface reaches, such as a shared layout imported through an alias usabl cannot
follow, is a coverage gap, so every card reads as not verified. Map those files, as the gap
reasons say, to get bound cards.

When no content requirement covers a scanned screen, the alt-text manifest for that
screen is drafted from the page instead. The docs run reads each image on the screen
(`img`, `role="img"`, `role="image"`, and `input type="image"`) and its accessible name
and role from the accessibility tree. Gating runs never read them. Each entry is the
image's element path and the text it has now. An image with no name reads `Marked
decorative on the page.` when its own `alt` is empty or its role is `none` or
`presentation`, and `No text alternative on the page.` otherwise. An `input type="image"`
with no `aria-labelledby`, `aria-label`, `alt`, `value`, or `title` gets a name from the
browser, "Submit" in English. That name is not text the page wrote, so it is drafted as
`No text alternative on the page.`, read from the attributes and never from the name, so the
browser's language does not change it.
That text is untrusted page text. It passes the published scrub, which also drops the query and
the fragment of any URL the page repeats, element paths included. Each string is cut to a fixed
number of characters, never inside a character, and marked `(shortened)` when cut, and at most
200 images are listed per screen, with one more entry that counts the rest. Every drafted entry
has `origin: 'page'` and `status: 'draft'`, and never an `evidenceRef`. The manifest itself
carries `origin: 'page'` too, so a screen that showed no images still reads as drafted from the
page, and its card says the page showed no images. It never becomes a check, a
requirement, or an approval. The HTML page labels such a card "Drafted from the page" and
says a person must review every entry. A screen that has content requirements keeps the
manifest built from them, and a screen whose images could not be read, or that usabl did
not see, gets no drafted manifest.

### Not v1

- Full VPAT automation.
- Auto-merge doc PRs without review.
- Real-time sync to a docs portal.

---

## 15. Future checks (easy to add)

What makes them cheap to add:

- The Page interface already supports viewport, zoom, reduced motion, computed style,
  and screenshot.
- The provider interface is open (any `layer` string, returns `Draft[]`).
- The gate filters on `evidenceClass`, not on a closed list of layers.
- Adding a provider never requires touching gate, guard, coverage, or receipts.

### Sketches

| Check | Layer name | What it does | Page capability used |
|---|---|---|---|
| Text resize | `resize` | Set viewport to 320px width or zoom to 200%, assert no content loss or overlap | `setViewport`, `setZoom`, `screenshot` |
| Target size | `target-size` | Measure interactive element bounding boxes, flag anything below 24x24 CSS px | `getComputedStyle`, `queryAll` |
| Visible focus | `focus-indicator` | Tab through; at each stop compare focused vs unfocused outline/box-shadow/border | `tab`, `getComputedStyle` |
| Consistent navigation | `nav-consistency` | Compare navigation landmarks across surfaces, flag structural differences | `axAt` across multiple pages |
| Captions | `media-captions` | Find video/audio elements, assert track[kind=captions] present | `queryAll` |
| Reduced motion | `motion` | Enable prefers-reduced-motion; flag elements with active animation/transition | `setReducedMotion`, `getComputedStyle` |

---

## 16. Advisory lane

Findings with `evidenceClass: 'model-judgment'` are surfaced but never block.

### How they appear

- **Overlay:** shown in a separate "Advisory" section, visually distinct.
- **PR comment:** grouped under `### Advisory (non-gating)` below the gating sections.
- **CLI:** printed after the verdict with a label.
- **Gate:** explicitly excluded from verdict computation.

### Sketches

| Check | What it does | Why model-judgment |
|---|---|---|
| Plain language | Assess reading level of user-facing text | Meaning is subjective |
| Alt-text quality | Judge whether alt text is descriptive enough | Quality vs presence |
| Link text clarity | Flag "click here" or vague link labels | Context-dependent |
| Heading quality | Assess whether headings describe content | Semantic judgment |
| Error message clarity | Judge whether errors help the user | Intent-dependent |

### A person decides

Advisory findings are presented as suggestions. The developer (or a reviewer) decides
whether to act on them. They are never written to the evidence floor. They do not
appear in receipts. They cannot produce waivers (there is nothing to waive; they are
not blocking).

---

## 17. Security controls

### Must ship

1. CODEOWNERS on every guarded path and the workflow. Branch protection or a ruleset
   that requires the `usabl-required` check (in place on this repository).
2. Config-guards-itself (integrity check before reading contents).
3. CI reads policy from trusted ref, refuses without base ref.
4. Receipt binding (four bindings, receipt store excluded from version control).
5. `neutralize()` on all page-derived text at every egress.
6. Localhost-only binds by default.
7. Pinned scanner versions; unreadable version degrades to `not_covered`.
8. Sticky-comment bot-author filter and NUL-delimited git plumbing.
9. Untrusted-data framing on every surface a model reads. The stop hook and the
   self-check print every value the Result carries inside one untrusted frame or
   type-check it first (section 11.2), and an MCP wrapper must do the same when it
   ships. `neutralize()` at every egress.
10. Requirement files (design intake) added to the guarded set.
11. The scan browser starts with Chromium's sandbox. Without one, the run says so, or refuses
    with exit 4 when `browserSandbox` is `"require"` (section 22, threat model Threat 14).

### Documented seams

- Cryptographic receipt signing via CI OIDC identity.
- Structural identity tier.
- Local tamper-proofing (impossible by design; keep the disclosure).
- MCP mid-task wrapper: optional transport over CLI; adds discoverability and
  prompt-injection surface the Bash path avoids (section 11.5).

---

## 18. Performance

### Strategy

- One warm browser per long-lived process, new context per screen.
- Receipt fast-path before any browser work.
- Per-screen cache keyed on (screen id, content hash), version-stamped.
- Page-ready: bounded network-idle wait capped at 2-3 seconds.
- Fan-out: parallelize affected screens. Do not subsample. If the hook cannot finish
  every affected surface inside the budget, the verdict is `not_covered`, not a sampled
  `verified`. Never mint a receipt on a partial scan. CI scans the same full set and
  may take longer.
- Tiered short-circuit: receipt, then axe, then rulepack, then walk. The hook may stop
  early once a blocking `regression` is known. CI still collects a complete finding
  set for the comment when practical.
- Single-flight per repo so the hook and overlay do not storm contexts.
- Block fonts, images, and analytics during scans.

### Budgets

- Receipt hit: under 20 ms.
- Fast loop (one warm surface, cache-cold): under 1.5 seconds.
- Full loop (all affected, parallel, under 10 screens): under 30 seconds.
- Per-screen cold: 1-4 seconds (dominated by the walk).
- CI wall-clock: under 3 minutes with browser binary cached.

---

## 19. Fixture app and oracle

A small PatternFly console with real routes: Overview, Clusters, Workloads, Settings,
on a shared AppShell, plus a shared StatusBadge used by two pages (proves coverage
fan-out). One switch (`?variant=broken` or `?variant=clean`) toggles only the planted
defects.

- Clean: zero findings (no false positives).
- Broken: exactly the planted count (any drift is a harness bug).

Planted defects on the broken Clusters page:

1. A kebab row-action toggle with no accessible name (catches `pf-icon-button-name`).
2. That same toggle missing aria-expanded (catches `pf-kebab-expanded-state`).
3. A modal that does not return focus on Escape (catches `pf-modal-focus-return`).
4. A success toast with no live region (catches `pf-toast-live-region`).
5. Every row's action button named "Actions" (catches `pf-row-action-name-unique`).

Planted defects on the broken Workloads page (so rules 3, 6, and 8 have an oracle):

6. A dialog or menu that does not move focus inside on open (catches
   `pf-focus-into-dialog`).
7. A table whose headers are not associated, or an empty/loading state that is not
   announced (catches `pf-table-header-assoc`).
8. Two repeated toolbars with no distinguishing accessible name (catches
   `pf-toolbar-labeled-when-repeated`).

Keep Settings identical in both variants to prove no false positives. The `?variant=`
switch lives in the fixture app, not on `ScreenScan`.

---

## 20. Build priorities

When scope must shrink, detection breadth goes first. Overlay and Reports stay.
Mid-task self-check via CLI stays; the MCP wrapper is optional (section 11.5).

### Cut line (dropped first)

1. `pf-toolbar-labeled-when-repeated`.
2. `pf-row-action-name-unique` and `pf-table-header-assoc`.
3. MCP wrapper (if the core loop is not solid yet).

Never cut: the gate, receipt fast-path, config-guards-itself, CODEOWNERS, four-verdict
output, announcement preview, overlay, Reports, CLI mid-task self-check.

---

## 21. Honest limits

### What usabl cannot do

- Certify compliance. It supports the work, it does not sign it off.
- Detect seizure-risk flashing. Frame-by-frame signal analysis is a different tool.
- Prove time-based logic (session timeouts, timed interactions).
- Replace a screen-reader user or an accessibility expert.
- Claim "accessible for everyone." It verifies what its checks cover, on the screens
  it checked, and says which is which.

### What it honestly discloses

- The announcement preview is an approximation from the accessibility tree, not a
  screen reader. It is labeled as a preview everywhere.
- CDP does not serialize aria-sort; that one fact is read from the DOM attribute. The
  exception is documented at the read site and disclosed in this document.
- Local enforcement is tamper-evident, not tamper-proof. CI reads policy from the trusted
  base ref, so a pull request cannot change the policy it is judged against; the head code
  it scans is still the pull request's own.
- Discovery misses bundler aliases, computed imports, and unparseable routes. Those
  are honest `not_covered`, never silent passes.
- Identity-weak rules (missing accessible name) use count-based identity because you
  cannot honestly key an unnamed element by name.
- Session pinning is best-effort (stored in a private per-user dir, clearable by the OS
  or by the same user with no message, and skipped with a disclosure when that dir is not
  private).

---

## 22. Config file

```json
{
  "appBaseUrl": "http://127.0.0.1:5173",
  "uiFileGlobs": ["fixtures/app/src/**"],
  "discovery": {
    "routerFile": "fixtures/app/src/App.tsx",
    "wideBlastGlobs": [
      "fixtures/app/src/main.tsx",
      "fixtures/app/src/App.tsx",
      "fixtures/app/src/**/*.css",
      "fixtures/app/index.html",
      "fixtures/app/vite.config.ts"
    ]
  },
  "surfaces": [
    {
      "id": "clusters",
      "url": "http://127.0.0.1:5173/clusters",
      "files": ["fixtures/app/src/ClustersPage.tsx"]
    }
  ],
  "requirements": "requirements/",
  "guardedPaths": [
    "usabl.config.json",
    "usabl.routes.json",
    "src/providers/rulepack",
    "src/gate",
    "src/trust",
    ".usabl-evidence.json",
    ".usabl-waivers.json",
    ".github/workflows/usabl-gate.yml",
    "requirements/"
  ],
  "readyTimeoutMs": 60000
}
```

Each `surfaces[].id` is the key coverage is tracked under. It must be unique across the list
and it must satisfy the one id grammar the product has, which is stated here exactly. The
grammar excludes the empty string, whitespace, invisible characters (control characters, format
characters, lone surrogates, private use, every `Default_Ignorable_Code_Point`, and the assigned
characters that render as blank: U+2800, U+13441, U+13442, and U+16FE4), and it requires
Unicode NFC form. Ids are compared exactly, which is the comparison the planner, the floor, and
the receipt already make, so the grammar is what keeps two ids from looking alike rather than
the comparison folding them together. Everything else a font draws is allowed, so a
discovery-derived id such as `users-:id` stays valid. A refused id is reported by index, with
the position and code point of the offending character, because printing an invisible character
back would show nothing.

The grammar does not claim more than it delivers. It refuses whitespace, control and format
characters, surrogates, private use, default-ignorable characters, and the known assigned blank
glyphs; it accepts everything else, including unassigned code points, standalone combining
marks, and cross-script confusables. It does not claim that an accepted id never reorders text:
visible right-to-left letters reorder the run they sit in without any control character, and
they are accepted, because Hebrew and Arabic ids are real ids. It does not claim that every
accepted character has a glyph in every font. Confusables across scripts are accepted, so a
Latin `a` and a Cyrillic `a` are both valid and stay distinct ids: the two never fold into one
entry, each is scanned when a change affects it, and waiver matching is exact, so neither screen
is hidden behind the other. What the grammar does not do here is stop a reader from mistaking one
for the other.
Unassigned code points are accepted, because rejecting them would make an id's validity depend
on which Unicode version the running Node build carries.

The same grammar governs every operator-authored and derived id on the `usabl` command path:
`surfaces[].id`, `usabl.routes.json` `screenId`, the screen id the router fallback derives from a
route path in application source, `usabl.docs.json` `pageId`, requirement ids and the surface a
requirement names (section 13), the keys of `noiseBudget.perSurface`, which are screen ids matched
against one by exact comparison, and every id that `usabl init` and `usabl init --docs` derive. An
authored id that fails is refused at parse. A derived id that fails is never minted. At run time
the router fallback sets such a route aside and the planner records it as a `skipped` coverage
gap whenever a wide-blast change would have queued it, so the gate reads it as not covered
rather than as absent. `usabl init` and `usabl init --docs` refuse the whole draft: a written
sidecar takes precedence over router fallback, the planners queue every route or page in the
sidecar or manifest on a wide-blast or shared-file change, and neither records a gap for an
entry that is not there, so a draft written without the refused route or page would let such a
change read as fully checked while that screen is never scanned. The refusal names every
unusable route or page by file (and line, for a route), with the position and code point when a
character was refused and the grammar reason otherwise (an empty id, or one not in NFC form,
which must be normalized), and the fix, never the id or the path it came from, and writes
nothing.

What that covers, and what it does not. The grammar holds for every id these commands actually
derive, and the line in a route refusal is the line of the path the parser read. It says nothing
about a route the parser found but could not read: no id is derived for it, so nothing refuses
it. `usabl init` names it in a `Review:` note with its file and line, and it is absent from the
draft until the operator adds it. What the router reader reads, reports, and still does not see is
listed under the documented limits in section 8.

The boundary, stated exactly. The grammar is also checked on the evidence floor, the waiver
ledger, and the inputs of the two exported functions that take ids, so it holds whichever door a
caller comes through:

- Reading `.usabl-evidence.json` checks `entries[].screenId`. Reading `.usabl-waivers.json`
  checks `waivers[].surface`.
- `gate()` checks `coverage.affected[].screenId`, `drafts[].screenId`,
  `floor.entries[].screenId`, `waivers[].surface`, and every member of `cleanlyScannedScreens`.
  A member of the set is named by its position in the order the set yields it, counting from 0.
- `mintReceipt()` checks `args.checked[]`, `args.applicability[].screenId`, and the id fields of
  the `UsablConfig` it is handed, `surfaces[].id` and the keys of `noiseBudget.perSurface`. A key
  is named by its position, counting from 1, in the order the config parser counts them.

A refusal is an `InputRefusedError`, exported from the package entry. Its `field` is the path of
the refused value with its position, for example `floor.entries[2].screenId`, and its message
names the same path, the grammar's reason, and the position and code point of a refused
character. Neither ever contains the id. On the command path every one of these ids already
passed a reader, so nothing that was accepted before is refused now, with one exception: a floor
entry or waiver whose id the grammar refuses used to be read and match nothing, and now the file
is refused by every command that reads it, because they share one parser. `usabl check` ends as
an unhandled error (exit 4) whose summary names the entry by position. `usabl floor prune`
refuses with exit 4 and writes nothing. `usabl doctor` reports the evidence floor or the waiver
ledger as drifted.
The grammar governs screen and surface ids only. It does not govern rule ids, element keys,
waiver scopes, receipt `notCovered` entries (file references), or receipt `surfaces` (output
channels).

A blank or repeated id is refused when the config is read. Left in, it would collapse two
screens into one entry: the second screen is dropped from the scan while its changed files
still count as mapped, and the run would report both screens as covered when only one was
ever opened.

### Three sources share one screen id space

Screen ids come from three places: `surfaces[].id` in `usabl.config.json`, `screenId` in
`usabl.routes.json`, and `pageId` in `usabl.docs.json`. App coverage and docs coverage are
concatenated into one run, and downstream the id alone keys floor identity, finding identity,
waiver matching, applicability, and source lookup. Each source already checked itself for
duplicates. Nothing checked across them, so one id could stand for two screens.

That is worse than losing a scan. Two screens under one id collapse to one map entry, so one is
never opened while its changed files still count as mapped. It also lets a floor entry belonging
to one screen absorb a genuinely new barrier on the other, which reads as carried debt and mints
a verified receipt over a real failure.

usabl refuses any id that could stand for more than one screen, checked when coverage is planned,
before the idle return, because a docs page can be scanned in a run where no app file changed.

The router fallback joins the segments of a path with `-`, so two paths can give one id: `/a-b`
and `/a/b` both give `a-b`. Neither route is named. Both are set aside like a route whose derived
id fails the grammar, so a wide-blast change records each as a `skipped` gap, and every other
route still runs. Only a wide-blast change names them. A narrow change, one whose files match no
wide-blast glob, maps a changed file to screens through route entry files, and a route read from
the router has none, set aside or not. So, unless a surface lists it, the changed file maps to no
screen and is reported as an `unresolved` gap that names the file, and the routes set aside are
not mentioned. `usabl drift routes` still counts every route set aside as a route the router
declares: a sidecar that names it reports no removal, and a sidecar that omits it reports it as
added, so drift never says "No drift detected" for a route check never scans. `usabl init` refuses the whole draft in that case, names the file and line of
each route that shares an id, and says to write `usabl.config.json` and `usabl.routes.json` by
hand, with a screen id of its own for each route, then run `usabl drift routes` to check the
sidecar against the router file. Running `init` again would refuse again, because it reads the
router before any file on disk.

**A surface and a discovered route may share an id, but the config has to say so.** Set
`"overridesDiscoveredRoute": true` on the surface. That is how a surface controls the scan URL for
a screen discovery already owns, which is what makes query variants and deep links possible.

usabl does not compare the two URLs and does not infer the relationship from them, because a URL
does not determine which screen renders:

- Applications select screens by query, fragment, trailing slash, and userinfo.
- Servers do not treat percent spellings as interchangeable. `/users/%61lice` and `/users/alice`
  are delivered as written.
- A redirect can send two requests for the same URL to two different screens, depending on session,
  server state, feature assignment, or time.

So even an identical URL proves only that the same address was requested. The declaration is the
only evidence usabl will accept, and `usabl init` writes it on every surface it derives from a
route.

Setting `overridesDiscoveredRoute` on a surface whose id matches no route in an authored
`usabl.routes.json` is refused, since the declaration would override nothing while reading as
though it were wired up. That check runs only against an authored sidecar. Router-text discovery
recovers paths but not ownership, so an id missing from it proves nothing, and the same shape is
what the trust guard leaves behind when it suppresses a diverged manifest. Refusing there would
throw away the findings of a run that can still report honestly.

**A docs page id may never equal a surface id or a route screen id.** There is no override
relationship between documentation and an application screen, so any overlap is refused outright.

Upgrading an existing config: a surface whose id matches a discovered route screen id will now be
refused until it declares the override or takes a different id. There is no safe way to infer the
answer, which is why usabl asks instead of guessing. Configs written by `usabl init` before this
change need `"overridesDiscoveredRoute": true` added to their surfaces.

`guardedPaths` is additive. The four policy files (`usabl.config.json`,
`usabl.routes.json`, `.usabl-evidence.json`, `.usabl-waivers.json`) are force-guarded by
`ALWAYS_GUARDED` whether or not they are listed here, and the requirements directory is
added when `requirements` is set. Listing rule modules, the gate, the trust code, and the
gate workflow puts them under the same `approval_required` review.

`surfaces[].reachedWhen` is optional. It is the screen's readiness signal: a CSS selector string,
or an object with a `selector`, a `response` path, or both, every one of which has to hold for the
screen to count as seen. See "Limits of detecting that a screen was not reached signed in" in
section 8 for exactly when each part holds, what the loader refuses, and what it does not prove.

`readyTimeoutMs` is optional and defaults to 60000. It is the whole budget for one screen
to navigate, for its network to go quiet, for its DOM to stop changing, and, when the surface
declares a `reachedWhen` selector, for that selector to match.

`signalTimeoutMs` is optional and defaults to 15000. It caps how long readiness waits for a
surface's `reachedWhen` selector, counted from the first moment the page settled, and it never
extends `readyTimeoutMs`. A screen whose selector does not match within it is not walked or
checked and is disclosed as `not-covered`, with a reason that names the selector and the cap. The
value must be a positive whole number of milliseconds, at most 600000 (ten minutes); anything else,
including a number too large to hold exactly, is refused when the config is read, and the refusal
names the field and the limit. How long that
takes is a property of the application, so a heavy authenticated app on a loaded lab may
need more: an Ansible Automation Platform screen measured 25.7 seconds. A screen that runs
out of budget is disclosed as `not-covered` with a reason naming which of the two phases
ran out, never scanned as if it had finished rendering. The value must be a positive whole
number of milliseconds; anything else is refused when the config is read, before a run
opens a browser.

`browserSandbox` is optional and is `"auto"` or `"require"`; absent means `"auto"`. usabl always
asks Chromium for its sandbox when it starts the scan browser. When Chromium reports that it cannot
start the sandbox on this system, as on Ubuntu 23.10 and later with restricted unprivileged user
namespaces or in many containers, `"auto"` starts the browser again without it and discloses that
in three places: a line in the `usabl check` output, a `browserSandbox: "off"` note on each screen
in the Result, and the chromium sandbox surface of `usabl doctor`, which gives the fix. The
fallback changes no verdict. `"require"` refuses to scan instead: the run ends with no verdict and
exit 4, and the summary says how to enable the sandbox. Only a launch failure whose text is
Chromium's own sandbox message (for example `No usable sandbox!` or
`Running as root without --no-sandbox is not supported`) counts; a missing Chromium, a missing library, or a crash is
reported as it is and never triggers the fallback. The decision is made once per browser process,
when it starts, so every page of that process shares it. The CLI and the overlay share this launch
path. With a trusted ref, `"require"` in either the working tree or the trusted-ref
`usabl.config.json` wins, so a pull request cannot turn a required sandbox off for its own scan.
Any other value is refused when the config is read, and the refusal names the field.

There is no `notCovered` mode key. When usabl is on, `not_covered` blocks. Idle
(nothing to check) is an explicit informational allow. That is code, not a config dial.

---

## 23. Rule validation and prioritization

### Data sources

- PatternFly GitHub issues labeled accessibility or a11y.
- Product bugs from issue trackers, anonymized and used only with permission.
- The PatternFly accessibility team's known problems list.
- WCAG failure patterns from public audits of PatternFly-based products.

A sample of 20 to 50 real bugs is enough to start. Use only public or
explicitly allowed data. No customer names in the repo.

### Method

1. Collect the sample of real accessibility bugs.
2. For each bug, determine which usabl rule (or rules) would have caught it.
3. Run the current rule set against reproductions of the bugs where possible.
4. Count: of N real bugs, the rules catch M. Report that number honestly.

### Why this matters

"We ran these rules against 30 real PatternFly bugs and caught 22 of them" is
evidence a reader can check. It validates the rule set against real pain, not
contrived fixtures. It also prioritizes: if a class of bug appears ten times in
the sample and no rule catches it, that rule goes to the top of the backlog.

### Rule selection rationale

The eight PF rules were chosen because they represent composition mistakes that:
- Are outside what the axe-core provider reports. The rulepack is a separate provider,
  and the focus rules need the component exercised. The one recorded comparison: a
  standalone axe run reported zero violations on the broken fixture dialog while
  `pf-focus-into-dialog` and `pf-modal-focus-return` failed.
- Real screen-reader users encounter regularly in PatternFly apps.
- Can be shown in a short run (visible on screen, audible in the transcript).

The five focus/interaction rules (1-5) carry the proof loop. The three structural rules
(6-8) add breadth. The cut line drops structural rules first.

---

## 24. Discovery improvement roadmap

### Current limits

- Only relative import paths are followed.
- Bundler aliases (`@/`, `~/`, tsconfig paths) are not resolved.
- Computed import specifiers (`import(variable)`) are not resolved.
- Routes built from a data table or registered dynamically are not extracted. Each is named
  as a gap with its file and line when it sits in the router file (section 8).
- Comment stripping in the import graph is regex-based and imperfect.

These produce honest `not_covered`, never silent passes.

### Improvement path (in priority order)

1. **tsconfig/vite alias resolution.** Read `tsconfig.json` paths and
   `vite.config` resolve.alias, then resolve non-relative specifiers against
   them. This covers the majority of alias patterns in real PF apps.
2. **Runtime route dump.** Start the app, extract the full route list from the
   running router (React Router exposes this), and use it instead of (or to
   supplement) the static parser. Handles dynamic and data-driven routes.
3. **Discovery diagnostics.** When a file lands in `unresolvedFiles`, emit a
   structured reason: "could not resolve `@/components/Foo` because no alias
   configuration was found." Give the developer a clear fix path.
4. **Storybook surface generation.** Auto-generate surface-map entries from
   Storybook stories, removing the mapping tax for teams that already use
   Storybook. A later **Storybook addon** (section 11.8) would run the same
   CLI check per story URL.

### Candidate pull-in

If real-repo `not_covered` is high, pull the runtime route dump (item 2 above)
forward. It is the single highest-leverage coverage improvement and has
more impact on trust than adding another deterministic rule.

### The trust cliff

If too many files are `not_covered`, teams lose trust in the tool. Mitigations:

- Discovery diagnostics (above) tell the developer exactly what to fix.
- Wide-blast ensures shell/CSS/config changes always check all known routes.
- Manual surface globs in config let teams bridge gaps immediately.
- The verified-verdict-rate metric (section 25) makes coverage visible, so the
  team can see it improving over time.
- The product never hides the gap. `not_covered` is loud on purpose.

---

## 25. Metrics and success criteria

### Verified-verdict-rate

The fraction of **UI-touching** changes the tool can actually verify (versus marking
`not_covered`). Idle / nothing-to-check runs are not in the denominator. Measured on
a real PatternFly surface, not the fixture app.

- **Target:** state whatever the number is, honestly. A rate above 70%
  on a real surface is strong. Below 50% needs explanation.
- **Measured by:** the maintainer, on a real-repo smoke pass.
- **Reported as:** one number, cited honestly.

### Stop-hook policy gate for `not_covered`

Do not lock this by philosophy alone. Tie behavior to the real-repo number:

- If `not_covered` is rare (for example, <=10% of UI-touching runs), keep hard block.
- If `not_covered` is common, switch to the existing one-continuation loud allow path
  for `not_covered` while discovery hardening lands.

Either way, keep `not_covered` loud, visible, and tracked in PR comment and overlay.

### Other metrics to track

| Metric | What it shows | Target |
|---|---|---|
| Time to first finding (new repo) | Adoption friction | Under 5 minutes |
| Violations prevented per PR | Value delivered | Track, report whatever it is |
| Re-check time (block to verified) | The "re-check after the fix" claim | Under 2 minutes for one screen |
| False positive rate (clean screen findings) | Trust | Zero on clean PatternFly markup |
| Rule coverage vs real bugs | Rule quality | Track against the sample (section 23) |

### How we report coverage to teams

The Result object includes `coverage.unresolvedFiles`. The overlay and PR comment
surface these as "files usabl could not map to a screen." The fleet view (later)
can aggregate coverage percentage across surfaces. The tool never hides a gap.

The fleet view's data source is runnable today as a measurement-only harness.
`npm run measure:fleet-insights` (from a repository clone) and the `usabl/measure`
export (`runMeasurementOnly`) walk the configured surfaces and report how many
screens surfaced draft findings and how many drafts in total. This harness never
mints a verdict, writes a receipt, or gates, and it is deliberately not a `usabl`
subcommand, so measurement can never be mistaken for a proof. The later fleet view
aggregates this measurement across repos; verdict authority stays with the gate.

### Sensitivity evidence (`usabl verify sensitivity`)

**What it measures.** Whether the shipped checks and the gate catch a declared set of defects, on
pages where usabl put each defect itself. It answers "does usabl see this kind of accessibility
barrier when it is there", one defect at a time. It says nothing about any other defect, and nothing about whether
a screen is accessible.

**The catalog.** `src/measure/sensitivity/catalog.ts` is a typed, versioned list. Each entry has a
stable id, one plain sentence, the WCAG 2.2 success criterion it breaks, the rule ids expected to
report it, the evidence class expected (deterministic or preview), where the rule is expected to
report it (on the changed element, inside it, on it or its shadow host, or anywhere on the
screen), and a mutation. A mutation is data: a target finder and one edit. The target finder reads the page only
through `Page.queryAll`, `Page.axAt`, and `Page.hostMarkup`, the reads the checks use. The edit is
one of eight fixed kinds: remove attribute, set attribute, remove text name, set style, remove
element, replace role, swallow a key, and make `focus()` calls do nothing. The two page functions
that carry them out are written once in `edits.ts`, and an entry's values reach the page only as
JSON arguments. They run in the page's own world, because two kinds change how the page's script
behaves. An edit that changes markup reads its change back at once, and again after the last
provider has run. The two script kinds count what they did: a swallowed key counts the keys aimed at
the element that reached the page first, and a stubbed `focus()` counts focus that reached the
element some other way, such as on an element the page added later or by autofocus. Focus by Tab or
by a pointer press is not counted, because the edit leaves both working on purpose. An entry that no
shipped rule claims carries the place where a claim to catch it is made.

**The run.** For each entry and screen: load the page and scan it with the real provider stack,
then gate the scan with the real `gate()` against an empty floor. Load the page again, make the
edit after readiness and before the transcript walk and every provider, scan it, and gate it
against a floor of what the clean scan found. Each finding the gate calls `new` and deterministic
is located on the mutated page, through every draft the gate collapsed into it, against the
elements the edit changed.

A new finding is dropped when every draft behind it has a rule and element path the clean scan
already reported: that is a finding the page already had, moved to a new identity because the edit
changed the name it was keyed on. Only a finding with confidence `fail` counts as a catch. An
`unverified` finding is the checks saying they could not tell.

The outcome, in this order:

- `unreadable` before anything loads: the entry needs a flow or voice requirement and the design
  requirements could not be loaded. The reason is the load error.
- `not applicable`: the screen cannot carry the defect. The entry needs a flow requirement, a voice
  requirement, or a documentation page the screen does not have; no element matches the target
  finder; the defect needs more elements than the page has (one toolbar needs no label); or a
  finding from an expected rule was already on a target element in the clean scan, so the defect
  was there before the edit.
- `unreadable`: the scans cannot say. Either scan had a coverage gap, including a screen marked
  unseen. The edit was not made, or did not take hold when it was read back at once. The gate did
  not verify the mutated scan, and no new finding explains it. Every new gating finding is
  `unverified`. Or the only definite new findings are away from the change, for an entry not
  reported on the screen: the two loads differ, so they prove nothing about the defect.
- `caught`: a new gating finding with confidence `fail` from an expected rule, where the entry says
  it reports. For an entry reported on the screen (`heading-one-removed`, `page-title-removed`,
  `dialog-focus-not-moved-in`, `flow-live-region-broken`, and `voice-live-region-broken`), that is
  anywhere on the screen.
- `caught by another rule`: a new gating finding with confidence `fail` from another rule, on the
  changed element. Counted apart from caught.
- `preview only`: nothing new gates, and a preview finding is new.
- `missed`: nothing new gates. When the edit cancels a key the checks never pressed on the element,
  the reason says so.

The second read comes last. It finds that the change did not hold through the scan when a markup
change is gone, a key aimed at the element got past the swallow, or focus reached the element in a
way the edit does not stop. Then `caught` and `caught by another rule` stand, because a new definite
failure, where the entry says it reports, was measured while the defect was there.
The row's reason notes that the change did not hold to the end of the scan, and why. Every other
outcome becomes `unreadable` with that reason, because a miss or a preview finding then proves
nothing: the checks may never have seen the defect.

**Two levels.** Level 1 runs each entry on its own fixture page, served on loopback from strings
in `level1.ts`, with no app and no config. The flow and voice pages bring their own requirements.
The RHDS page defines small stand-in elements with the tag names and shadow structure the RHDS rules
read; it does not load `@rhds/elements`. Level 2, only with `--app`, runs every entry on every
surface in `usabl.config.json` (or the ones `--screen` names), through `buildDeps`, so the provider
stack, the requirements, and the session are the team's own. Only the flow and voice entries scan
with the team's requirements; every other entry scans with none, so the team's flow and voice steps
run only for those two entries. It needs the app running and the `live` capability. Before it
starts it prints the real counts for the screens chosen: each load uses the team's saved session;
the dialog and menu probes click every dialog trigger and menu toggle on each load; for the flow
and voice entries the screen's flow and voice steps run on each of their loads, so a step that
saves or deletes data runs that many times. Both levels go into one file, kept apart.

**The attestation.** `.usabl/sensitivity.json` holds the schema version, the engine version and
scanner versions a receipt binds, the catalog version and hash, the date (an input), each entry's
outcome, rules, screen, and reason per level, the totals per outcome, and every rule of the
deterministic checks (axe, PatternFly, RHDS, keyboard walk, docs) the catalog does not exercise,
with the reason. A rule that only gives preview findings, such as `voicing/silent-change`, is not
in that list. The same tree, versions, and pages give the same bytes
apart from the date. It is scrubbed on the way out. The terminal summary says "caught N of M catalog
defects" per level, where M counts the entries that were made and read, lists every outcome other
than caught by name with what was expected, and reports a level where nothing could be made and read
as measuring nothing, not as a pass.

**Isolation.** The mutation browser is built only by the verify command, which the CLI loads by a
dynamic import inside that command. No config field or environment variable selects it. `buildDeps`
never builds it; Level 2 hands it in through the `browserFor` option. No module that run(), the gate,
the stop hook, the overlay, the CI judge, the pull request comment, checkPage, or the library entry
imports reaches it, and nothing on those paths reads the attestation.
`test/measure/sensitivity/isolation.test.ts` pins both.

**Level 1, measured.** On the fixture pages the catalog caught 25 of the 28 defects it could
make and read. Two were missed: `control-out-of-tab-order` (a visible button with `tabindex="-1"`;
no shipped rule reports a control Tab never reaches) and `menu-does-not-open-on-enter` (the menu
probe opens a menu with a click, so no check presses Enter on the toggle). `voice-live-region-broken`
was preview only, as voice findings are until a class is promoted. `menu-toggle-state-removed` was
caught by `pf-kebab-expanded-state`, and its row notes that the change did not hold to the end of
the scan: the menu probe clicks the toggle, and the fixture's script sets `aria-expanded` again.
`test/measure/sensitivity/level1.real.integration.test.ts` pins every outcome.

**Limits.** A catch on the fixture pages is a catch on that markup. On a team's app, a mutation
can land on an element where it creates no accessibility barrier for users, for example a live
region the flow does not use, and that reads as missed; read a Level 2 miss with the screen in
hand. The edits run in the page's own world, so page script can see them and could undo one. The
second read catches a markup change that is gone by the end of the scan, not one the page undid and
then made again in between. A page key listener on the window that ran before the edit was made is
not seen by the key count. Edits reach the top document only. A page with no focusable element
cannot be measured: the keyboard walk never leaves the body, so the screen reads as unseen and
every entry on it is unreadable. Pages listed in `usabl.docs.json` are not measured on Level 2:
it reads only the surfaces in `usabl.config.json`, and a surface carries no documentation profile,
so the documentation entry is not applicable on any Level 2 screen. A finding is located after every provider has acted, so a path such as
`nth-child(5)` can name another element by then, for example after a toast was added. A defect the
catalog does not declare is not measured, and every rule of the deterministic checks that no entry expects is listed in
the file. Preview rules are not listed.

---

## 26. Screen-reader validation

**Validation reader (Orca on Fedora).** Orca is the validation-harness target.
Because guidepup automates VoiceOver and NVDA only (not Orca), the harness cannot
drive Orca programmatically. Instead, Orca's spoken output is captured via a
speech-dispatcher log module or a manual transcription pass, then compared offline
to the Virtual Screen Reader transcript.

The in-run announcement preview is derived from the accessibility tree captured during
the transcript, not from a real screen reader; its honesty class is "preview, not real
AT." usabl also ships its own headless virtual screen reader provider
(`makeVirtualSrProvider`, the voicing lane), which runs the voice requirements a team
writes and emits preview evidence unless an obligation class is promoted (section 7.5); it is
usabl's own code, not the npm
`@guidepup/virtual-screen-reader` package, which is not a dependency in v0.2.0. The
engine is screen-reader-agnostic; the validation harness measures the virtual-SR
transcript's fidelity to a real reader, not to one product.

If text-to-speech is used in a recording, label it "synthesized from the announcement
transcript" and never imply it is live screen-reader output.

Disclose any attribute-read exception (aria-sort) wherever results are presented. In an
accessibility honesty claim, an undisclosed "we read the DOM here" undercuts the claim.
Disclosing it proactively reinforces it.

Credibility checks before publishing a recording:

- Verify AX-tree preview text is a fair approximation of what a real screen reader
  announces for the broken and the fixed state; compare separately with Orca output
  for the validation pass.
- Sweep for any other CDP serialization gaps so `aria-sort` is truly the only
  disclosed attribute-read exception.

---

## 27. Settled decisions

| Decision | Answer |
|---|---|
| Product name | usabl |
| AI coding assistant for stop hook | Claude Code (Stop lifecycle event) |
| Target design system | PatternFly v6 |
| Repo | github.com/usabl-dev/usabl (public, Apache-2.0) |
| Stack | TypeScript on Node 22, Vitest, Playwright, axe-core |
| Adoption model | On or off. No modes. Advisory findings surface and never block (advisory lane, not a mode). |
| Idle vs not_covered | Nothing to check is explicit informational allow, not `not_covered`. |
| Partial scans | Forbidden for `verified`. Full affected set or `not_covered`. |
| notCovered behavior | Not a config knob. Default hard block; recalibrate from the real-repo `not_covered` rate. |
| Overlay / Reports | Built. Not on the cut line. |
| CLI | Built. Foundation; all surfaces call it. |
| Mid-task self-check | Built via CLI (Bash). Same Result as MCP. |
| MCP wrapper | Optional, not built. Discoverability vs a fourth transport (section 11.5). |
| IDE / LSP extension | Out. Overlay + CLI cover hand-coding. |
| Other assistants (Cursor, Copilot) | Seam: same CLI + hook/MCP adapter. Claude Code and Cursor ship today (section 11.7). |
| Storybook addon | Later seam (section 11.8). |
| How many PF rules | Eight, with a cut line (structural rules first). |
| Validation reader | Orca on Fedora; spoken output is captured and compared offline to the Virtual Screen Reader transcript. |
| Evidence labels | On every Draft from day 1. v0.2 = all deterministic. |
| Design intake in scope | Schema + YAML normalize in v0.2. Figma/CSV ingest is a seam. |
| Reports in scope | Generate the three artifacts, bound to receipt. |
| Documentation checking | Shipped in v0.2.1. Same engine, `profile: 'docs'`, activated by a `usabl.docs.json` manifest. One verdict, or none, across app and docs. |

### Still to decide

| Decision | Who decides | When |
|---|---|---|
| Real PatternFly repo for the smoke pass | The maintainer | Open |
| Verified-verdict-rate target to state publicly | The maintainer | After measurement |
| Real bug sample for rule validation | The maintainer | Open |
| MCP wrapper vs Bash-only mid-task check | The maintainer | Open |

---

## 28. WCAG 2.2 coverage map

This section maps every WCAG 2.2 Level A and Level AA success criterion (55 total;
4.1.1 Parsing was removed in 2.2) to what usabl does about it. This is the honest
answer to "how much accessibility does this tool ensure?"

Categories:

- **Built (deterministic):** usabl checks this now, mechanically, and can produce
  `verified` or `regression`.
- **Stretch (deterministic):** A candidate check to prove the architecture. Not built
  yet.
- **Planned (deterministic):** Easy to add as a provider. The Page capabilities
  and provider interface support it. We just have not built the provider yet.
- **Advisory (model-judgment):** usabl can surface a suggestion via the advisory lane
  but cannot verify it mechanically. A person decides.
- **Not applicable:** The criterion does not apply to a rendered web UI component check
  (e.g. time-based media for a PatternFly admin console).
- **Never:** usabl will never satisfy this. The criterion requires something outside
  the tool's scope (human judgment, application logic, or signal analysis).

### Principle 1: Perceivable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 1.1.1 | Non-text Content | A | Built (axe) + Advisory (quality) | axe checks presence of alt/aria-label (deterministic). Advisory lane judges whether the text is actually useful (model-judgment). Design intake can assert exact approved alt text (deterministic). |
| 1.2.1 | Audio-only/Video-only (Prerecorded) | A | Not applicable | PatternFly admin consoles rarely have prerecorded media. If present, this is a content decision outside the component library. |
| 1.2.2 | Captions (Prerecorded) | A | Planned | Check for `<track kind="captions">` on video elements. Simple DOM query. |
| 1.2.3 | Audio Description or Media Alternative | A | Not applicable | Same as 1.2.1. |
| 1.2.4 | Captions (Live) | AA | Never | Live captioning is a runtime service decision, not a component property. |
| 1.2.5 | Audio Description (Prerecorded) | AA | Not applicable | Same as 1.2.1. |
| 1.3.1 | Info and Relationships | A | Built (axe + PF rulepack) | axe checks semantic structure. PF rulepack checks table header association, toolbar labeling, live regions. |
| 1.3.2 | Meaningful Sequence | A | Built (axe) | axe checks reading order against DOM order. |
| 1.3.3 | Sensory Characteristics | A | Advisory | Requires understanding whether instructions rely on shape/color/location. Model-judgment. |
| 1.3.4 | Orientation | AA | Planned | Set viewport to portrait/landscape, assert no content loss. Uses `setViewport`. |
| 1.3.5 | Identify Input Purpose | AA | Built (axe) | axe checks autocomplete attributes on common input types. |
| 1.4.1 | Use of Color | A | Built (axe, partial) | axe flags some color-only information. The eight PF rules do not include a status-color-only check; do not cite a rule that is not in §7.2. |
| 1.4.2 | Audio Control | A | Not applicable | PatternFly admin consoles do not auto-play audio. |
| 1.4.3 | Contrast (Minimum) | AA | Built (axe) | axe owns color contrast checking. usabl does not reimplement it. |
| 1.4.4 | Resize Text | AA | Planned | Set zoom to 200%, assert no content loss or overlap. Uses `setZoom`. Not a stretch goal. |
| 1.4.5 | Images of Text | AA | Built (axe) | axe flags images used as text. |
| 1.4.10 | Reflow | AA | Planned | Set viewport to 320px CSS width, assert no horizontal scroll. Uses `setViewport`. |
| 1.4.11 | Non-text Contrast | AA | Built (axe) | axe checks UI component and graphical object contrast. |
| 1.4.12 | Text Spacing | AA | Planned | Inject increased spacing via CSS, assert no content loss. Uses `getComputedStyle` + `setViewport`. |
| 1.4.13 | Content on Hover or Focus | AA | Planned | Trigger hover/focus content, assert dismissable + hoverable + persistent. Declarative probe. |

### Principle 2: Operable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 2.1.1 | Keyboard | A | Built (keyboard walk + PF rulepack) | The keyboard walk tabs through interactive elements and reports a focus trap. No shipped rule reports a visible control that is not on the Tab path (section 25 measures this). PF rules cover dialog focus, kebabs, and row actions. |
| 2.1.2 | No Keyboard Trap | A | Built (keyboard walk) | Cycle detection in the walk. A Tab cycle that never reaches the body is `keyboard-walk-trap`, plus a truncation gap. A cycle inside one open modal dialog is a truncation gap only. See 7.3. |
| 2.1.4 | Character Key Shortcuts | A | Never | Requires knowing whether single-character shortcuts exist in application logic. |
| 2.2.1 | Timing Adjustable | A | Never | Time limits are application logic. usabl does not run over time. |
| 2.2.2 | Pause, Stop, Hide | A | Planned | Detect auto-updating/moving content and assert a pause mechanism exists. Partially possible with animation detection. |
| 2.3.1 | Three Flashes or Below | A | Never | Seizure detection requires frame-by-frame photosensitivity analysis. A different tool. |
| 2.4.1 | Bypass Blocks | A | Built (axe) | axe checks for skip links and landmark regions. |
| 2.4.2 | Page Titled | A | Built (axe) | axe checks document title presence. |
| 2.4.3 | Focus Order | A | Built (keyboard walk) | The walk records focus order. PF rulepack checks focus-into-dialog and focus-return. "Illogical" order is visible in the transcript; the check does not judge meaning. |
| 2.4.4 | Link Purpose (In Context) | A | Advisory | Whether link text is descriptive requires understanding intent. Model-judgment. |
| 2.4.5 | Multiple Ways | AA | Never | Whether there are multiple ways to find a page is an IA decision, not testable per screen. |
| 2.4.6 | Headings and Labels | AA | Built (axe) + Advisory | axe checks heading structure exists. Whether headings are descriptive is model-judgment. |
| 2.4.7 | Focus Visible | AA | Stretch | Tab through, compare focused vs unfocused computed styles. The stretch-goal check that *is* a 2.2 A+AA criterion. |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | Planned | At each focus stop, check whether the element is obscured by sticky/fixed positioned elements. Uses `getComputedStyle` + position checks. |
| 2.5.1 | Pointer Gestures | A | Never | Whether multi-point or path-based gestures have single-pointer alternatives is application logic. |
| 2.5.2 | Pointer Cancellation | A | Never | Up-event firing behavior is application logic. |
| 2.5.3 | Label in Name | A | Built (axe) | axe checks that visible label text is included in the accessible name. |
| 2.5.4 | Motion Actuation | A | Never | Whether motion-triggered actions have alternatives is application logic. |
| 2.5.7 | Dragging Movements | AA | Never | Whether drag operations have non-dragging alternatives is application logic. |
| 2.5.8 | Target Size (Minimum) | AA | Planned | Measure bounding boxes of interactive elements, flag below 24x24 CSS px. Uses `getComputedStyle`/bounding box. Today a `target-size` requirement measures each control a design names (section 13.1), and axe's own `target-size` rule runs only in the docs profile: the docs profile passes the `wcag22aa` tag, and axe runs a rule that is off by default when a tag selects it. The app profile passes no tags, so axe runs only its default rules there, and `target-size` is off by default in axe-core 4.13. |

### Principle 3: Understandable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 3.1.1 | Language of Page | A | Built (axe) | axe checks for `lang` attribute on `<html>`. |
| 3.1.2 | Language of Parts | AA | Built (axe) | axe checks `lang` on elements with different language content. |
| 3.2.1 | On Focus | A | Built (keyboard walk) | The walk flags observable context changes on focus (document URL change, or focus moving to a different control than the one just focused). It does not judge "unexpected" in the WCAG sense. |
| 3.2.2 | On Input | A | Planned | Declarative probe: change an input value, assert no unexpected context change. |
| 3.2.3 | Consistent Navigation | AA | Planned | Compare nav landmarks across surfaces, flag structural differences. Multi-page check. |
| 3.2.4 | Consistent Identification | AA | Planned | Same function = same label across surfaces. Multi-page comparison. |
| 3.2.6 | Consistent Help | A | Planned | Check that help mechanisms appear in the same relative order. Multi-page. |
| 3.3.1 | Error Identification | A | Advisory | Whether errors are identified clearly requires semantic understanding of error states. Partially checkable via aria-invalid + aria-describedby. |
| 3.3.2 | Labels or Instructions | A | Built (axe) | axe checks that form inputs have labels. |
| 3.3.3 | Error Suggestion | AA | Advisory | Whether error messages suggest a fix requires understanding content. Model-judgment. |
| 3.3.4 | Error Prevention (Legal/Financial) | AA | Never | Whether a submission is legal/financial is application context. |
| 3.3.7 | Redundant Entry | A | Never | Whether previously entered info is auto-populated is application logic. |
| 3.3.8 | Accessible Authentication (Minimum) | AA | Never | Authentication flow design is application architecture. |

### Principle 4: Robust

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 4.1.2 | Name, Role, Value | A | Built (axe + PF rulepack + walk) | The core of what usabl checks. axe validates ARIA usage. PF rulepack checks PF-specific name/role/value patterns. The walk reads actual name, role, and state from the accessibility tree. |
| 4.1.3 | Status Messages | A | Built (PF rulepack) | `pf-toast-live-region` checks that status updates reach assistive technology via live regions. |

### Summary

WCAG 2.2 Level A+AA is **55** criteria (4.1.1 was removed). Counts below match the
tables, not a rounded marketing total.

| Category | Count | Percentage of Level A+AA |
|---|---|---|
| **Built (deterministic)** | 21 | 38% |
| **Stretch (deterministic, not built)** | 1 (2.4.7) | 2% |
| **Planned (deterministic, buildable)** | 13 | 24% |
| **Advisory (model-judgment, never verified)** | 4 | 7% |
| **Not applicable** (media in admin consoles) | 4 | 7% |
| **Never** (application logic, human judgment) | 12 | 22% |

Reduced motion is a stretch **provider** (preference injection). It is not a 2.2 A+AA
row, so it is not in the 55.

**What we can say:**

- As built: usabl mechanically verifies 21 of 55 Level A+AA criteria (38%).
  With visible-focus stretch, 22 (40%).
- With the planned providers built: 35 of 55 (64%).
- With advisory included (surfaced, person decides): 39 of 55 (71%).
- The remaining 16 (29%) are not applicable to admin consoles (4) or require
  application logic or human judgment the tool will never replace (12).

**What we do NOT say:**

- "usabl makes your app WCAG compliant." It does not. Compliance requires all
  criteria including the ones only a human can judge.
- "usabl covers X% of accessibility." WCAG is not the whole of accessibility.
  The tool verifies what its checks cover, on the screens it checked.

### Stretch goals (prove the architecture)

Two candidate checks that would prove the provider interface extends without touching
the gate. Neither is built yet. Only 2.4.7 counts in the 55. Reduced motion is extra.

1. **Visible focus indicator** (`focus-indicator` provider, WCAG 2.4.7)

   Tab through the page. At each stop, compare computed styles (outline, box-shadow,
   border) between focused and unfocused state. Flag any interactive element where
   focus produces no visible style change. Uses the keyboard walk + `getComputedStyle`.

   Why this one: it is genuinely non-trivial (not just a DOM query), it combines two
   Page capabilities (walk + style inspection), and it catches a WCAG AA criterion
   that axe handles poorly (axe only checks `outline: none` statically).

2. **Reduced motion** (`motion` provider, related to WCAG 2.3.3/2.2.2)

   Enable `prefers-reduced-motion: reduce` via `setReducedMotion(true)`. Inspect
   computed `animation-name` and `transition-duration` on all elements. Flag any
   element with active animation under the reduced-motion preference.

   Why this one: it exercises preference injection (proving the tool can test
   user-preference scenarios), it catches a real user harm (vestibular disorders),
   and it is deterministic (no screenshots, no timing).

Rules for stretch goals:
- Only attempt once the core loop is solid.
- Do NOT add them to the fixture oracle. Run on a real-repo smoke pass.
- If they cause any instability, delete them. They are never on the "never cut" list.
