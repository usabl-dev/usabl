# usabl: consolidated design

Status: working draft. Author: eparenti. August 2026.

This is the project ground truth for the usabl product. It is one document that covers
the check-agnostic core, evidence labels, design intake, Reports, and the on/off
adoption model.

This document describes usabl v0.2.2: an Apache-2.0 accessibility proof engine, published
as ESM, requiring Node >=22, with a single bin `usabl` mapped to `./dist/cli.js`. Where
this document and the source disagree, the source is authoritative.

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
  intake/           schema.ts normalize.ts load.ts config.ts trusted-config.ts map-to-providers.ts overlay-fs.ts
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
  excludedFiles?: ExcludedFile[]; // disclosure only: test-folder files no screen imports
}

// A changed file that matches uiFileGlobs but that the planner left out on purpose. Today that is
// a file in a test folder that no screen imports. Not a gap: the gate never reads it. Absent and
// empty both mean nothing was excluded.
export interface ExcludedFile {
  ref: string;    // repository path
  reason: string; // why it was left out, and what would make it count
}

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
one entry per screen and status, with the count and every element path, after the other
findings in the same list. The collapsed views (pull request comment, Stop hook, self
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
   alert passes only when the nearest value above it is polite or assertive and the
   alert does not set off on itself. Its own live value does not count as a
   container. An alert that cannot be found again, for example a toast that closed on
   its timer, and an alert with more than 512 ancestors each become their own
   not-covered gap, never a pass, and the check goes on to the other alerts.
2. `pf-modal-focus-return`: open a modal, press Escape, focus returns to the exact
   trigger.
3. `pf-focus-into-dialog`: focus moves into a dialog or menu on open.
4. `pf-kebab-expanded-state`: kebab and menu toggles carry correct aria-expanded and
   aria-haspopup, and focus enters the menu.
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
| `rhds-button-accessible-label` | `rh-button` | no `accessible-label`, no default-slot text, and the tree name of the inner button is empty | tree |
| `rhds-cta-link` | `rh-cta` | no `href` or an empty one, and its first child in the default slot is not an `a` or a `button` | markup |
| `rhds-tabs-paired` | `rh-tabs` | the count of `rh-tab` children in the tab slot differs from the count of `rh-tab-panel` children in the default slot | markup |
| `rhds-dialog-name` | `rh-dialog` | no `accessible-label`, no `h1` to `h6` heading in the header or default slot, no trigger with text, and the tree name of the inner dialog is empty | tree |
| `rhds-switch-label` | `rh-switch` | no `accessible-label`, no `label[for]` that names its id, and the tree name of the host is empty | tree |
| `rhds-accordion-header-parent` | `rh-accordion-header` | its parent is not `rh-accordion` | markup |
| `rhds-skip-link-target` | `rh-skip-link` | no `href` (or an empty one) and no slotted `a`, or an `href` fragment that names no element by id (or an anchor by name) in the document, as written or percent-decoded | markup |

Default slot means a child with no `slot` attribute or with `slot=""`, as the DOM assigns
it. The component takes any unslotted heading as its name, so an `h1` counts.

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

**How the walk ends.** The walk starts on the body. Only focus on the body completes it: a
browser moves focus there after the last control on the page. Tab that brings focus back to
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

**Test files.** A file named like a test, `*.test.*` or `*.spec.*`, is never a UI file, wherever
it is. A file in a folder named `test`, `tests`, or `__tests__` is a UI file only when a screen
reaches it: a route entry file's import graph includes it, or a surface lists it in its `files`.
So a screen component kept in `src/tests/` is checked when it changes. A file in such a folder
that matches `uiFileGlobs` and that no screen reaches, such as `src/test/setup.ts`, a helper in
`src/__tests__/`, or a mock request handler in `src/test/`, is left out and disclosed in
`coverage.excludedFiles`, with a reason that says usabl found no import of it and how to make it
count. It is not a gap, so a pull request that edits only test helpers still has nothing to check.
`usabl check` prints these files under "excluded files, not checked", marked as not blocking, on
any run, an idle one included. It prints the first 20 and then the count of the rest; the JSON
output holds the full list.

"No screen reaches it" is read from the import graph, so it is a guess when the graph holds an
import usabl could not resolve. When an unresolved import's last path segment, with or without its
extension, equals the file's name without its extension (or its folder name, for an `index` file),
the file is an `unresolved` gap that names the import and the file that holds it. For example,
`src/pages/Home.tsx` imports `@/tests/Dashboard` with no alias config, so a change to
`src/tests/Dashboard.tsx` is a gap. An unresolved import that names another file changes nothing.
A dynamic import built from a template literal, such as `` import(`../tests/${name}`) ``, names no
file, so a file it loads stays excluded. That is a known limit.

**Files usabl cannot place.** Each file in `unresolvedFiles` gets an `unresolved` gap whose ref
is its repository path. The reason says why usabl could not place it, then the fix: add it to the
`files` of a surface in `usabl.config.json`, or add the route that renders it to
`usabl.routes.json` with an `entryFile` that imports it. Any import usabl could not follow on the
way comes last, as discovery detail. A docs source gets the docs form of the fix: add it to a
page's `sources` in `usabl.docs.json`, or to its `sharedGlobs`. The common case is a shared file,
such as a layout every route imports through an alias usabl does not resolve. `usabl check` names
the first such file in its gap list and then lists every other one with its reason, sorted.
`usabl baseline` scans every UI file, so it is where these show up first: its refusal on
incomplete coverage, and its `--partial` report, list every such file with its reason, sorted. No
page text is printed in either list.

An import with no extension is probed against a fixed list: `.mjs`, `.js`, `.mts`, `.ts`, `.jsx`,
`.tsx`, `.vue`, and `.svelte`, then the same names as `index` files in a directory. usabl does not
read `resolve.extensions` from the Vite config, because it cannot run the config. When more than
one candidate exists, for example `Widget.vue` beside `Widget.tsx`, usabl does not pick one: the
import links every candidate, so a change to any of them maps to the screen. That can scan a
screen that does not render the changed file, and never leaves out one that does. The ambiguity
is still disclosed: the gap of a changed file that maps to no screen names every candidate of an
ambiguous import on its way. Write the import with its extension to resolve it. One case is not disclosed: an extension outside
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
Result that `usabl check --json` writes, the pull request comment, and the `usabl docs` report
(JSON and `--html`) drop the userinfo, the query, and the fragment from every URL in the Result,
the same way `checkPage` output does. Nothing reads those surfaces back to match a gap to a
screen, so dropping them costs no match.

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
   malformed (the harness stays closed for unreadable requirements). Findings
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
renders again it comes back as a new finding and blocks a later change, which may be one that
did not touch it. It never reads as a pass of that accessibility barrier for good. Point
`reachedWhen` at an element of the content itself, not the shell, so a screen whose content did
not mount never holds its signal.

Otherwise the identity is not claimed `fixed`. It gets no finding, which is what a floor entry on a
screen the run did not scan already gets, so it is not paid down, it is not counted fixed in the
receipt, it is not reported as headroom, and the floor keeps its full count as debt. The verdict
does not change and no gap is raised. Instead the run shows a notice for each such screen. It names
the screen, the rules, and the number of barriers, and gives the fix, for example: "3 recorded
accessibility barriers on screen orders (button-name, link-name) were not seen in this run, so they are not
claimed fixed. If they are fixed, add a reachedWhen signal for this screen or run usabl floor prune
--unconfirmed." It never names an element key, because a key carries page text. The summary line
gains a `N recorded barriers not seen, not claimed fixed` clause that counts barriers, not entries,
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

Five bindings are compared on re-verification:
- `sourceTree`: hash of the working tree (git write-tree on a temporary index).
- `policyHash`: sha256 over sorted guarded-path blob shas at the anchor.
- `runnerVersion`: package version + sha256 over the engine's own shipped files
  (first-party `dist/*.js` in the installed package, or the `src` tree when run from
  source). A change to any shipped engine file moves this hash, so a receipt minted by
  one engine build cannot re-verify under a tampered or upgraded engine.
- `scannerVersions`: the axe-core, Playwright, and Chromium versions that decided the
  verdict. `verifyReceipt` compares these too, so a swapped or upgraded scanner
  invalidates the receipt.
  When an optional commercial engine is on, `scannerVersions.engines` maps its id to the
  installed package version, and `verifyReceipt` compares that map too: a version change,
  or an engine turned on or off, invalidates the receipt. An absent map and an empty one
  both mean no engine (section 7.7).

- `historyHead`: the commit of the debt history branch the run read, or null. The history can
  lower the debt a run accepts, so a receipt minted before the history moved stops matching,
  and the Stop hook's fast path falls back to a full run. Added in receipt schema version 2. A
  stored version 1 receipt is not read, which costs one full run.

A source-tree change or committed policy change invalidates the receipt, and so does an
engine or scanner change or a move of the history branch.

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
`session`, `debt`, `history`, `serve-build`, `extract-build`, `verify`, and `help`. `check` is the default
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
  `routes` is the only subcommand; anything else exits 2.
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
  verdict. GitHub stays out of `run()`.
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
  A barrier headline outside the frame reads `- barrier 1: [new serious] (×3)`, and its
  pieces inside the frame carry the same number: `barrier 1: axe/color-contrast`,
  `screen (1): ...`, `experience (1): ...`, `fix (1): ...`. One barrier reads
  `Barrier: [new serious] (×3)` with `barrier: <layer>/<rule>` and `screen: <id>` inside, then
  its experience and fix. When guarded files changed,
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
  the message budget, N line(s) omitted (K barrier(s) left out); run usabl check --json for
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

**Size bound.** GitHub refuses a comment body over 65,536 characters, and the required check
then fails with no comment. The comment body, counted with the newline the CLI writes after
it, is at most 60,000 UTF-16 code units (`COMMENT_BODY_LIMIT` in `src/surfaces/pr-comment.ts`).
Every carried value is cut to a fixed length, marked `[shortened, N characters omitted]`.
Coverage gaps are named up to 20 per state, and one line counts the rest of each state, as the
transcript names up to 20 stops per screen. When the body is still over the bound, whole items
are cut, lowest priority first: announcements, disclosed notes, advisory findings, recorded
debt, notices for floored accessibility barriers not seen, gaps after the first of each state, the framed
detail under a gating finding, the first gap of each state, and last a gating finding's first
line. The marker, the verdict line, the approval line, the judge line, the receipt, the
conformance counts, and the debt lines are never cut. Each section that lost items says how
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
still reads a workflow that holds the sentinel as not wired: the gate on its `ci` line, and the
history workflow on its own `history-ci` line, recognised for whichever branch its trigger names
(no history workflow reads as missing, since it is optional). The report lists the outcome for
each file, then the facts once, then the steps still needed: pin the engine (only with the
sentinel), run `usabl init` or fix `appBaseUrl` (only when `usabl.config.json` has no loopback
http `appBaseUrl` with a port), add a `dev` script (`install --ci` only, when `package.json` has
none), merge `usabl.config.json` (and `usabl.routes.json` when the working tree has one) to the
default branch first in their own pull request (`install --ci` only, unless git shows that
`refs/remotes/origin/<default branch>` already holds the same bytes; the judge reads them at the
base commit, so a pull request that adds them with the workflows cannot pass), and, when a file
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
approvals on push, each by classic protection or by an active ruleset; a ruleset on
`~DEFAULT_BRANCH` counts only when the repository's default branch is `main`. Each part that is
off is "not applied", and each it cannot read is "cannot verify". `usabl doctor` reports the same, and reports `workflow-owners`: wired only when the last
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
`usabl-required` (the workflow *file* is named `usabl-gate`), and the protected branch is
`main`. Both `enforce` commands read Result JSON from stdin and never call the gate.

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
names. The text below says main for that branch. It builds the engine with the same `usabl-engine` job
as the gate, and each later job fetches the archive and the record with usabl's own fetcher,
checks the archive against `engine_digest`, and checks the unpacked tree before each engine run. Its
`history-scan` job checks out main, reads `appBaseUrl` from main's `usabl.config.json`, starts
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
when that is not plain, why: an intake requirement (content, flow, or voice) applies only to
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
provider per content, flow, or voice design requirement. `checkPage` reads `usabl.config.json` from
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
Anything that hides the region by the drain decides, which can only make the capture hear less. It covers a region inside `aria-hidden="true"`, an
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
`src/index.tsx`, `src/App.tsx`, `src/App.jsx`, `index.html`, `src/index.html`, the Vite config, and
the CSS files under `src/` exist in the app folder, because a change to any of them can reach
every screen. Path aliases come from the `tsconfig.json`, `tsconfig.app.json`, and Vite config in
the app folder, the configs that app's compiler and bundler read.

**Which app `init` drafts.** `usabl init --app <dir>` drafts the app in that folder, written
relative to the repository root, such as `usabl init --app packages/web`. A folder outside the
repository, one with no files, and one written with a glob character (`*`, `?`, `[`, `]`, `{`,
`}`, or `!`) are refused, because a glob could name several apps at once. With no flag, `init`
drafts the root app when the root has a Vite config, a router file, or `src/**/*.tsx` or
`src/**/*.jsx` files. Otherwise it
looks below the root: a folder with a Vite config two levels down anywhere, or three under
`packages/` or `apps/`, and a folder under `packages/` or `apps/` with a router file. It skips
`node_modules`, `dist`, `build`, `coverage`, and hidden folders. When it finds one app, it drafts
that app and says so in a `Review:` note. When it finds more than one, it refuses, writes
nothing, lists every app it found, sorted, and names the `--app` flag to use, because a config
drafted for the wrong app checks the wrong files.

Every path `init` writes stays relative to the repository root: `uiFileGlobs`, the router file,
`wideBlastGlobs`, and each entry file carry the app folder, such as `packages/web/src/**/*.tsx`.
`usabl.config.json` and `usabl.routes.json` are written at the root, and `guardedPaths` names
them there, so CODEOWNERS and the trusted-ref guard still match them. A config drafted for one
app treats a change in another app as no UI change. A workspace package the app depends on is
different, because the app may render components from it. When the app's `package.json` depends
on a package found under `packages/` or `apps/`, a `Review:` note names it and says to add its
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

`usabl check` itself does not refuse a config with empty `uiFileGlobs` yet. Such a config,
written by hand or by an older `init`, still reads as nothing to check on every run.

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

### Many shapes in, one RequirementBundle

```
Figma export ──┐
YAML in repo ──┼──> normalize() ──> RequirementBundle
CSV alt text ──┘
PF checklist ──┘
```

The normalizer accepts multiple input formats and produces one `RequirementBundle`.
In v0.2, hand-authored YAML in the repo is the primary shape.

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

A `content`, `flow`, or `voice` requirement runs only on a screen whose id is its surface. When a run
scans anything, each such requirement whose surface matches no configured surface, no screen
in the route manifest, and no page in the docs manifest becomes a `not-covered` gap with ref
`requirement:<id>` that names the surface. No run would ever plan that screen, so nothing
checks the requirement, and a misspelled surface would otherwise turn it off while the run
read as verified. A requirement on a known screen that the change did not touch is out of
scope for that run, not a gap. The surfaces are read through the same trusted view the run
plans coverage with. `checkPage` applies the same rule through the same code.

Content and flow Drafts carry `evidenceClass: 'deterministic'` (the assertion is hard and
repeatable). `mapRequirementsToProviders` emits deterministic drafts with rule id
`intake:<id>` for content and flow requirements; there is no code path that marks an intake
draft as model-judgment. Voice requirement drafts carry the `voicing/` rule ids of the two
tiers, with the requirement in place of `voicing/`, and are `preview` unless their obligation
class is promoted (section 7.5). A flow or voice provider can also return `voicing/silent-change`
drafts, which are always `preview` (section 7.5.1).

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
run `usabl docs` again. `usabl docs` reads the tree again after the run, so a file saved while
the scan ran marks the report stale in its JSON and on its `--html` page. On the page a stale
card reads "Out of date", never "Verified", and the overview counts the stale cards. A report
saved earlier and read again is checked with `markStaleDocArtifacts(artifacts, currentTree)`
from `usabl/docs`. All of these use one check, `markStale` in `src/docs/evidence-binding.ts`.
No usabl command reads a saved report back; a static HTML page saved to disk cannot mark
itself, so regenerate a page before publishing it.

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
mode does.

When no content requirement covers a scanned screen, the alt-text manifest for that
screen is drafted from the page instead. The docs run reads each image on the screen
(`img`, `role="img"`, `role="image"`, and `input type="image"`) and its accessible name
and role from the accessibility tree. Gating runs never read them. Each entry is the
image's element path and the text it has now. An image with no name reads `Marked
decorative on the page.` when its own `alt` is empty or its role is `none` or
`presentation`, and `No text alternative on the page.` otherwise.
That text is untrusted page text. It passes the published scrub, which also drops the query and
the fragment of any URL the page repeats, each string is cut to a
fixed length and marked `(shortened)` when cut, and at most 200 images are listed per
screen, with one more entry that counts the rest. Every drafted entry has `origin:
'page'` and `status: 'draft'`, and never an `evidenceRef`. It never becomes a check, a
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
| 2.5.8 | Target Size (Minimum) | AA | Planned | Measure bounding boxes of interactive elements, flag below 24x24 CSS px. Uses `getComputedStyle`/bounding box. |

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
