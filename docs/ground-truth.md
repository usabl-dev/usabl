# Usabl: consolidated design

Status: working draft. Author: eparenti. August 2026.

This is the single source of truth for the Usabl product. It replaces shared-design.md,
contest-build-plan.md, and team-work-plan.md with one document that includes the
check-agnostic core, evidence labels, design intake, docs output, and the on/off
adoption model.

---

## 1. Product thesis and name

**Name:** Usabl. Tagline: "Usable by default." Supporting line: "Don't ship until
it's Usabl."

**Problem.** AI tools now write a large share of UI screens, and they often build
things a screen reader cannot use. Today's tools point out problems, but they do
not confirm a fix actually worked, and nothing stops the AI from calling work "done"
when a screen reader still cannot use it. Meanwhile, James uses a screen reader daily
and waits releases for fixes. Priya builds the UI with great intentions but misses
things because it is hard to know everything.

**What Usabl is.** A proof engine for accessibility in product development workflows.
It checks whether a screen is truly usable by a screen reader before work can be
called done. It gives one of four clear answers:

| Verdict | Meaning |
|---|---|
| `verified` | Touched surfaces were checked; no new problems. |
| `regression` | A new problem appeared. |
| `not_covered` | Could not identify or exercise what the change touched. |
| `approval_required` | Policy changed; the tool will not judge itself. |

The AI can suggest fixes. It does not get to grade its own work.

**One check, four places it shows up.** The same engine runs behind all of these:

1. Inside the AI coding assistant (the stop hook). The headline.
2. In the browser while coding by hand (the dev-server overlay). Advises, does not block.
3. On the pull request (the CI check). Blocks the merge if accessibility got worse.
4. In the team's existing tests (a Playwright helper). A seam for later.

---

## 2. What is new

The core new idea: almost every accessibility tool, including the new AI ones, scans
and gives advice a human may or may not read. Usabl does not advise. It decides, and
it can stop the AI from calling work done until a screen reader could actually use the
screen.

The specific things that are new, each against what exists today:

1. It verifies the fix, not just finds the problem. The field's own reviews say most
   tools find issues and almost none confirm the fix actually worked. Usabl closes
   that gap.
2. It proves it checked everything. It reports "we could not check this" as a real
   answer instead of quietly passing. Reporting unknown as unknown is rare.
3. Its answers can be re-checked. Every result is tied to the exact code and can be
   recomputed by anyone.
4. It shows what a screen reader would actually say, and diffs it. Simulating
   screen-reader output is a gap the field names itself, and using that
   before-and-after as evidence on a code change is new.
5. It has rules for our design system. There is a tool like this for one design system
   (Microsoft built one for FluentUI) and none for PatternFly. Usabl fills an empty
   slot.
6. The rules cannot be gamed. The AI cannot quietly weaken the checks to pass, because
   the rules are protected.

What is honestly not new: general scanning exists, and blocking only new problems
against a baseline exists. The new part is putting all of it into one loop that gates
an AI on evidence you can re-check and that is grounded in what a screen reader
actually hears. That combination does not exist today.

---

## 3. Scope

### Contest (built to full)

- The check-agnostic core (gate, coverage, guard, receipts, evidence labels).
- Three scan layers behind one provider interface: axe-core, PatternFly rulepack,
  pattern-aware keyboard walk.
- Four surfaces: stop hook, overlay, CI/PR comment, Playwright helper (seam).
- Evidence labels on every Draft (`evidenceClass`). During the contest everything is
  `deterministic`.
- Design intake interface (RequirementBundle schema and normalization).
- Accessible docs output interface (DocArtifact schema and generation).
- Page capabilities wired in the deps interface (viewport, zoom, reduced motion,
  computed style, screenshot) even though contest checks do not use them.

### Easy to add after the contest (deterministic checks we can call verified)

- Text resize and reflow at 200 percent.
- Target size for touch and pointer.
- Visible focus indicator.
- Consistent navigation across screens.
- Captions present.
- Reduced motion respected.

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
   `deterministic` (a hard, repeatable check), `model-judgment` (an AI model's
   assessment), or `human-confirmed` (something a person verified). During the contest
   everything is `deterministic`. The label means we can add model-judgment checks later
   without changing the data at all.

4. **Only deterministic checks can produce a verified.** The gate filters on
   `evidenceClass` before computing the verdict. Model-judgment findings are surfaced
   but never count toward or against `verified`. One of them can never slip into a
   verified answer by accident.

5. **Give the page tool a few extra abilities now.** Even though we will not use them
   for the contest, the Page interface supports changing the zoom and window size,
   reading computed styles, taking a screenshot, and enabling reduced-motion preference.
   Setting these up now is what makes later checks cheap to add.

### Module map

```
src/
  contracts/        index.ts
  primitives/       cssPath.ts glob.ts slug.ts sortKey.ts neutralize.ts identity.ts
  deps/             index.ts real.ts fakes.ts
  providers/
    axe/            index.ts notes.ts
    rulepack/       index.ts <one-file-per-rule>.ts
    keyboard-walk/  index.ts steps.ts
  evidence/         evidence.ts hash.ts receipt.ts
  dedup/            index.ts
  transcript/       diff.ts
  coverage/         index.ts importGraph.ts routeManifest.ts
  gate/             index.ts
  guard/            index.ts
  intake/           normalize.ts schema.ts
  output/           docs.ts altText.ts
  surfaces/
    stophook/       index.ts
    ci/             index.ts comment.ts
    overlay/        vite-plugin.ts client.ts
    mcp/            server.ts
    playwright/     index.ts
  cli.ts
fixtures/
  app/
  golden/
test/
usabl.config.json
.usabl-evidence.json
.usabl-waivers.json
.github/workflows/usabl.yml
```

### Check-agnostic data flow

```
Providers (axe, rulepack, walk, future)
    │
    │  each returns Draft[] with evidenceClass
    ▼
Dedup (collapse same defect across layers)
    │
    ▼
Gate (the single verdict authority)
    │  filters: only evidenceClass=deterministic counts
    │  applies: identity, differential, waivers
    │  computes: verdict
    ▼
Result (the whole serializable output)
    │
    ├── Stop hook (block/allow)
    ├── Overlay (show)
    ├── CI/PR comment (block merge)
    ├── Playwright helper (return Result)
    ├── MCP tool (present verdict; caller never decides)
    └── Docs output (publish artifacts)
```

---

## 5. Contracts

These are the shapes that cross module boundaries. Freeze them day 1. Every list is
sorted by a stable key before it is hashed or snapshotted.

```ts
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type EvidenceClass = 'deterministic' | 'model-judgment' | 'human-confirmed';
export type Verdict = 'verified' | 'regression' | 'not_covered' | 'approval_required';
export type FactSource = 'ax-tree' | 'attribute';

export interface Fact<T = string | null> {
  value: T;
  source: FactSource;
  verified: boolean;
}

export interface EvidenceFacts {
  name?: Fact;
  role?: Fact;
  state?: Record<string, Fact<unknown>>;
  extra?: Record<string, unknown>;
}

export interface Draft {
  rule: string;
  layer: string;                  // open, not a closed union
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
  elementKey: string;
  status: 'new' | 'carried' | 'fixed' | 'waived';
}

export interface AnnouncementToken {
  kind: 'name' | 'role' | 'state';
  text: string | null;
  verified: boolean;
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
  variant?: 'clean' | 'broken';
  stops: TranscriptStop[];
  drafts: Draft[];
}

export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual';
  importChain?: string[];
}

export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
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
  mintedAt: string;
}

export interface Result {
  verdict: Verdict;
  summary: string;
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4;
}

// Design intake
export type RequirementKind = 'content' | 'flow' | 'doc';

export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion: ContentAssertion | FlowAssertion | DocAssertion;
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

export interface RequirementBundle {
  version: 1;
  requirements: Requirement[];
}

// Docs output
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
}

export interface BrowserDriver { open(url: string): Promise<Page>; }

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
  // Capabilities wired for future checks (not used by contest providers)
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
```

---

## 7. Scan layers (contest)

Three layers, one `Provider` interface. The gate does not know or care how many
providers exist.

```ts
export interface Provider {
  layer: string;
  scan(page: Page, screen: { id: string; url: string }): Promise<Draft[]>;
}

export interface RuleModule {
  id: string;
  severity: Severity;
  why: string;
  fix: string;
  evaluate(page: Page): Promise<Array<{
    elementPath: string;
    elementName: string | null;
    role: string | null;
    evidence: EvidenceFacts;
    confidence: 'fail' | 'unverified';
  }>>;
}
```

### 7.1 axe-core provider

Wraps axe-core so it returns `Draft[]`. It owns color contrast, alt text, and general
WCAG-mapped checks. A curated notes table overrides axe's default `why`/`fix` text for
common rules with plain-language PatternFly-specific guidance. Every Draft has
`evidenceClass: 'deterministic'`.

### 7.2 PatternFly rulepack

Eight named rules, each a small module returning `Draft[]`:

1. `pf-toast-live-region`: toasts, alert groups, inline validation, and async table
   loading must sit in a role=status/alert/aria-live region that exists before the
   update.
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

Cut line (dropped first if time runs short): 8, then 7 and 6. Protect 1-5.

### 7.3 Keyboard walk

Tab through the page and record/assert focus: the focused element's accessible name
and role at each step and after each interaction, read from the accessibility tree over
CDP. Bounded with a Tab cap around 200, cycle detection, a wall-clock ceiling, and
per-node partial tree reads.

Runs a small set of data-step kinds passed as data: `tab`, `press-escape`, `activate`,
and `assert-announced(region, contains)`.

Marks any focus it cannot confirm as `unverified` rather than passing. Does not hang
on a focus trap.

### 7.4 Declarative interaction probes

Multi-step interactions expressed as data (JSON steps a generic runner executes). A
step that cannot establish its fact emits `unverified`. Adding a new interaction check
needs no engine change, just data.

---

## 8. Coverage and discovery

### How it works

Given a set of changed files, discover which surfaces they affect:

1. Build a route manifest from the router source (or use a configured override).
2. Build a static import graph from each route's entry file (BFS over imports).
3. Match each changed file against the import-graph closures.
4. Wide-blast fallback: files matching `wideBlastGlobs` (global CSS, app shell, build
   config) affect every extracted route.
5. Manual surface globs in config are an additive fallback, never a replacement.
6. Anything resolving to nothing stays in `unresolvedFiles` and forces `not_covered`.

### Prove what you touch

Only changed files trigger checks. A file you did not touch is not a Usabl problem
this PR. Coverage grows as the team works, not as a boil-the-ocean inventory.

### Documented limits

- Bundler aliases (`@/`, `~/`) are not resolved. They become `unresolvedFiles`.
- Computed import specifiers (`import(variable)`) are not resolved.
- Comment stripping is regex-based and imperfect.
- Routes not parseable from the router source must be configured or stay unmapped.

These are honest `not_covered` outcomes, not silent passes.

---

## 9. Gate (verdict authority)

The single module that constructs a Verdict. No other module can.

### Verdict computation

1. **Filter by evidenceClass.** Only Drafts with `evidenceClass === 'deterministic'`
   participate in the verdict. Model-judgment and human-confirmed findings are
   surfaced in the Result but do not block or enable `verified`.
2. **Guard check.** If any guarded path differs from the trust anchor, the verdict is
   `approval_required` and the harness never runs.
3. **Run checks.** For each affected surface, run providers, collect Drafts, apply
   identity, run differential against evidence floor and waivers.
4. **Verdict priority order:**
   - Any new deterministic failure: `regression`.
   - Anything unverifiable (unreachable surface, incomplete check, unmapped file):
     `not_covered`.
   - Everything else: `verified`.

### Failure taxonomy

- No changed files or no mapped screen: `not_covered`.
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

### CI (tamper-proof)

CI requires `--trusted-ref` (a forge-supplied base revision). Config, evidence,
waivers, and rules are read via `git show <ref>:<path>` from the trusted base, never
from the PR working tree. Combined with CODEOWNERS + branch protection, a PR author
cannot influence what policy they are judged against.

### Config-guards-itself

Check the config file's own integrity against the anchor before trusting its contents
to build the guarded set. Always force config, evidence, and waiver files into the
guarded set regardless of what config says. Ordering is load-bearing: integrity check
before reading contents.

### Session pinning

At session start, record sha256 pins of every guarded path keyed by session id, stored
outside the repo in the OS temp dir. The stop hook checks pins mid-session to catch a
committed tamper that git-status-clean cannot see.

### Receipt binding

Three hashes:
- `sourceTree`: hash of the working tree (git write-tree on a temporary index).
- `policyHash`: sha256 over sorted guarded-path blob shas at the anchor.
- `runnerVersion`: package version + sha256 prefix over on-disk engine files.

Any file change or committed policy change invalidates the receipt.

### CODEOWNERS + branch protection

Every guarded path and the CI workflow require code-owner review before merge. Admins
can bypass in an emergency (enforce_admins: false). This is the single highest-value
security item.

---

## 11. Surfaces

### 11.1 Stop hook (headline)

Fires on the assistant's Stop lifecycle event. Behavior matrix:

- Unconfigured repo: allow silently.
- No UI change in the diff: silent allow.
- Valid receipt on an unchanged tree: fast allow in under 20 ms, no browser.
- `verified` on a fresh scan: mint receipt and allow.
- `regression`: block.
- `approval_required`: block.
- `not_covered`: block (Usabl is on or off; not_covered is not done).
- Policy mismatch against git anchor: block.
- One-continuation escape: at most one forced continuation, then a loud disclosed
  allow marked "NOT verified."
- Hook error: fail open with disclosure, never a wedge.
- A findable single-run bypass (env var) so a wrong block means "bypass once and
  file it," not "delete the hook."

### 11.2 Overlay (dev-server)

A thin renderer over Result in the dev server. Shows findings as you save, right next
to the screen you are building. Advises, does not block. Oracle-preserving: mounts
only when `navigator.webdriver` is false and `?usabl=off` is not present.

### 11.3 CI/PR comment (tamper-proof)

Reads policy from the protected branch, never the working tree. Refuses to run without
a base ref. The comment leads with the receipt, groups findings as new/known/unverified,
shows a before-and-after announcement diff, and applies a noise budget. All page-derived
text passes through `neutralize()`. Sticky comment matched only among bot-authored
comments.

### 11.4 MCP on-demand check

A voluntary tool the agent can call during work so it self-corrects while context is
warm. MCP is transport only. The gate stays at the Stop event and is never an optional
tool the agent can decline. Page-derived text is framed as untrusted data.

### 11.5 Playwright helper (seam)

A documented entry point that returns the core Result. Teams can call the same check
from the tests they already run. A starting point, not a focus for the contest.

---

## 12. Adoption model

### On or off

Usabl is installed (hooks + CI + overlay, one standard) or the team is not using
Usabl. There is no "partial" mode, no per-surface strictness, no lasting observe mode.

### Brownfield adoption (prove what you touch)

A team in year four of a 400-screen console adopts Usabl on Monday without mapping 400
screens on Monday.

1. Install Usabl (on).
2. Most PRs that do not touch UI: silent allow (no UI files changed).
3. First UI PR on an unmapped page: `not_covered` until someone adds a surface map
   entry.
4. First check of that page: likely a pile of existing findings. A code owner accepts
   the evidence floor (and maybe a few waivers). That is one `approval_required` commit.
5. Next PR on that page: full default stack. New problems block. Old ones are visible
   debt that burns down when fixed or when a waiver expires.

Coverage grows as the team works. It does not require Design to declare epic scope.

### Ratchet

Same full check every time. Existing findings are the floor. New findings are
regressions. The floor only shrinks (via fixes or tightened accept) and never silently
grows.

### Waivers

One finding, owned, expiring. Not "this page is advisory." Required fields: rule,
surface, scope, owner, reason, approvedBy, created, expires. An expired waiver covers
nothing; the finding becomes a regression again. Debt burns down by default.

### What adoption is NOT

- Per-surface severity dials.
- "Legacy stays at observe until a team claims it."
- Design declaring in-scope epics or journeys.
- A way to make Usabl quieter on some screens.

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

### Many shapes in, one RequirementBundle

```
Figma export ──┐
YAML in repo ──┼──> normalize() ──> RequirementBundle
CSV alt text ──┘
PF checklist ──┘
```

The normalizer accepts multiple input formats and produces one `RequirementBundle`.
During the contest, hand-authored YAML in the repo is the primary shape.

### Guarded

Requirement files are guarded paths. Changing them triggers `approval_required`. Design
cannot weaken checks; only engineering + code owners change rule modules. Design can
add content and flow assertions that the engine enforces alongside the default stack.

### Mapping to checks

- `content` requirements become content-matcher providers (compare element text or
  aria-label against the approved string).
- `flow` requirements become declarative interaction probes (same step runner as the
  keyboard walk probes).
- `doc` requirements are not runtime checks; they feed the output module.

All intake-derived Drafts carry `evidenceClass: 'deterministic'` (the assertion is
hard and repeatable) unless the requirement explicitly marks itself as needing human
judgment.

---

## 14. Accessible docs output

### What it generates

After a verified run, produce published documentation from verified evidence plus
approved content requirements:

- **Alt-text manifest:** element, approved text, status (draft/approved), evidence link.
- **Announcement snippets:** per surface, what a screen reader would announce at each
  interactive stop.
- **Keyboard paths:** the Tab order through each surface with the announcement at each
  stop.

### AI drafts, humans approve

AI can propose alt text or doc copy. Usabl publishes only entries with
`status: 'approved'`. Draft entries are visible but clearly labeled.

### Bound to evidence

Each DocArtifact is bound to the code state via `boundToReceipt`. If the code changes
and the receipt is invalidated, stale docs are marked as needing regeneration.

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
| Visible focus | `focus-indicator` | Tab through, at each stop assert a visible focus ring (contrast, area) | `tab`, `screenshot`, `getComputedStyle` |
| Consistent navigation | `nav-consistency` | Compare navigation landmarks across surfaces, flag structural differences | `axAt` across multiple pages |
| Captions | `media-captions` | Find video/audio elements, assert track[kind=captions] present | `queryAll` |
| Reduced motion | `motion` | Enable prefers-reduced-motion, assert no animation runs | `setReducedMotion`, `screenshot` (before/after) |

---

## 16. Advisory lane

Findings with `evidenceClass: 'model-judgment'` are surfaced but never block.

### How they appear

- **Overlay:** shown in a separate "Advisory" section, visually distinct.
- **PR comment:** grouped under "Model suggestions (not blocking)" below the verdict.
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

1. CODEOWNERS + branch protection on every guarded path and the workflow.
2. Config-guards-itself (integrity check before reading contents).
3. CI reads policy from trusted ref, refuses without base ref.
4. Receipt binding (three hashes, receipt store excluded from version control).
5. `neutralize()` on all page-derived text at every egress.
6. Localhost-only binds by default.
7. Pinned scanner versions; unreadable version degrades to `not_covered`.
8. Sticky-comment bot-author filter and NUL-delimited git plumbing.
9. Untrusted-data framing in MCP tool output.
10. Requirement files (design intake) added to the guarded set.

### Documented seams

- Cryptographic receipt signing via CI OIDC identity.
- Structural identity tier.
- Local tamper-proofing (impossible by design; keep the disclosure).

---

## 18. Performance

### Strategy

- One warm browser per long-lived process, new context per screen.
- Receipt fast-path before any browser work.
- Per-screen cache keyed on (screen id, content hash), version-stamped.
- Page-ready: bounded network-idle wait capped at 2-3 seconds.
- Fan-out: cap affected-screen count, scan a deterministic sample in the fast loop,
  defer the tail to CI.
- Tiered short-circuit: receipt, then axe, then rulepack, then walk. Stop early on a
  blocking failure.
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

Keep Settings identical in both variants to prove no false positives.

---

## 20. Work breakdown and team

### How the work is split

- **Nitin** builds the detection engine (accessibility depth).
- **Ed** builds the verdict core, AI loop, and intake/output interfaces (lead).
- **Patrick** owns performance, behavior tests, demo capture, CI infra.
- **Vishali** owns real-reader validation, honesty audit, adversarial security suite.
- **Jim** makes the demo and presentation (week 4).

### Pairings

- Nitin builds accessibility, Vishali reviews accessibility.
- Ed builds the loop and surfaces, Patrick reviews and hardens them.
- Ed owns intake/output interface design; Nitin wires intake-derived providers.

### Integration

The detection engine (Nitin) and the gate (Ed) integrate around day 6-8. Before
that they work apart against the frozen contracts.

### Schedule (4 weeks total, week 4 is demo polish)

- Day 1: contracts, primitives, deps, fakes, oracle. Lock by end of day.
- Days 2-5: parallel build (providers, rulepack, walk vs. coverage, gate, guard).
- End of week 1: working vertical slice with all four verdicts reachable.
- Days 6-8: integration, surfaces, security controls, intake/output interfaces.
- Days 9-11: harden, measure, real-repo smoke pass, overlay, docs output.
- Days 12-14: full loop working end to end; all surfaces wired.
- Week 3: polish, fix real-repo findings, performance tuning, demo asset capture.
- Week 4: demo production, rehearsal, deck, and buffer. No new features.

The MVP and the demo are the same artifact. We are building what we demo the
entire time. Week 4 is for Jim to produce the polished video, the team to
rehearse the live segment, and everyone to practice the narrative.

### Cut line (dropped first)

1. `pf-toolbar-labeled-when-repeated`.
2. The overlay clip.
3. MCP on-demand tool.
4. `pf-row-action-name-unique` and `pf-table-header-assoc`.

Never cut: the gate, receipt fast-path, config-guards-itself, CODEOWNERS, four-verdict
output, transcript diff, and the recorded hero loop.

---

## 21. Honest limits

### What Usabl cannot do

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
  exception is documented at the read site and disclosed in the demo.
- Local enforcement is tamper-evident, not tamper-proof. CI is the tamper-proof tier.
- Discovery misses bundler aliases, computed imports, and unparseable routes. Those
  are honest `not_covered`, never silent passes.
- Identity-weak rules (missing accessible name) use count-based identity because you
  cannot honestly key an unnamed element by name.
- Session pinning is best-effort (stored in temp dir, clearable by OS).

---

## 22. Config file

```json
{
  "appBaseUrl": "http://127.0.0.1:5173",
  "uiFileGlobs": ["fixtures/app/src/**"],
  "notCovered": "block",
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
    "src/providers/rulepack",
    "src/gate",
    "src/guard",
    ".usabl-evidence.json",
    ".usabl-waivers.json",
    ".github/workflows/usabl.yml",
    "requirements/"
  ]
}
```

Note: `"notCovered": "block"` (not "advise"). Usabl is on or off.

---

## 23. Rule validation and prioritization

### Data sources

- PatternFly GitHub issues labeled accessibility or a11y.
- Product bugs in Jira or Bugzilla (Red Hat internal, anonymized).
- The PatternFly accessibility team's known problems list.
- WCAG failure patterns from public audits of PatternFly-based products.

A sample of 20 to 50 real bugs is enough to start. Use only public or
explicitly allowed data. No customer names in the repo.

### Method

1. Collect the sample of real accessibility bugs.
2. For each bug, determine which Usabl rule (or rules) would have caught it.
3. Run the current rule set against reproductions of the bugs where possible.
4. Count: of N real bugs, the rules catch M. Report that number honestly.

### Why this matters

"We ran these rules against 30 real PatternFly bugs and caught 22 of them" is
evidence for the judges. It validates the rule set against real pain, not
contrived fixtures. It also prioritizes: if a class of bug appears ten times in
the sample and no rule catches it, that rule goes to the top of the backlog.

### Rule selection rationale

The eight PF rules were chosen because they represent composition mistakes that:
- axe cannot detect (they require interaction or multi-element awareness).
- Real screen-reader users encounter regularly in PatternFly apps.
- Are demonstrable in a short demo (visible to judges, audible in the transcript).

The five focus/interaction rules (1-5) carry the demo. The three structural rules
(6-8) add breadth. The cut line drops structural rules first.

---

## 24. Discovery improvement roadmap

### Current limits (contest)

- Only relative import paths are followed.
- Bundler aliases (`@/`, `~/`, tsconfig paths) are not resolved.
- Computed import specifiers (`import(variable)`) are not resolved.
- Routes built from a data table or registered dynamically are not extracted.
- Comment stripping is regex-based and imperfect.

These produce honest `not_covered`, never silent passes.

### Improvement path (post-contest, in priority order)

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
   Storybook.

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

The fraction of UI-touching changes the tool can actually verify (versus marking
`not_covered`). Measured on a real PatternFly surface, not the fixture app.

- **Target for demo:** state whatever the number is, honestly. A rate above 70%
  on a real surface is strong. Below 50% needs explanation.
- **Measured by:** Vishali, on the real-repo smoke pass.
- **Shown in demo:** one slide, one number, cited honestly.

### Other metrics to track

| Metric | What it shows | Target |
|---|---|---|
| Time to first finding (new repo) | Adoption friction | Under 5 minutes |
| Violations prevented per PR | Value delivered | Track, report whatever it is |
| Fix verification time (block to verified) | The "verify the fix" claim | Under 2 minutes for one screen |
| False positive rate (clean screen findings) | Trust | Zero on clean PatternFly markup |
| Rule coverage vs real bugs | Rule quality | Track against the sample (section 23) |

### How we report coverage to teams

The Result object includes `coverage.unresolvedFiles`. The overlay and PR comment
surface these as "files Usabl could not map to a screen." The fleet view (later)
can aggregate coverage percentage across surfaces. The tool never hides a gap.

---

## 26. Demo strategy

### Timeline

The contest runs 4 weeks. Week 4 is demo polish and rehearsal. The MVP and the
demo are the same artifact. We build what we demo.

- Weeks 1-2: core engine, surfaces, and the vertical slice working end to end.
- Week 3: real-repo smoke pass, performance tuning, asset capture, overlay polish.
- Week 4: Jim produces the polished video from raw captures. Team rehearses the
  live segment. Deck finalized. No new features.

### AI coding assistant

Claude Code (Claude's stop hook lifecycle event). Confirmed.

### Storyline

1. Open cold on sound. Several seconds of the broken spoken announcement before
   any UI appears. A screen-reader user lives with this across release cycles.
2. Cut to the AI assistant mid-task on a real PatternFly screen. It thinks it is
   done.
3. The stop hook blocks. The four verdicts render plainly, with `not_covered`
   shown on purpose. The seeded bug is a focus or interaction defect that a
   screen-reader user feels, not contrived missing alt text.
4. The assistant fixes it, calling the on-demand check mid-task. The hook re-runs
   and passes. A receipt is shown once.
5. Replay the clean announcement. Start and end on sound. The before/after
   announcement diff is the empathy payload.
6. One live reveal at the end: type a fresh broken change and watch the hook
   block it live.
7. Supporting and fast: one PR-comment screenshot, one short overlay clip, one
   sentence each on the waiver, the differential, and the fleet roadmap.

### Asset strategy

Hybrid. A recorded, polished hero loop is the spine. Pure-live is too fragile for
an agent, browser, and hook chain on contest hardware. One short live reveal at
the end, because pure-recorded reads as staged.

### Audio and honesty

Record a real Orca pass (Vishali, week 1) of the broken and clean demo flows. Use
it as the hero audio. If text-to-speech is used as a fallback, label it
"synthesized from the announcement transcript" and never imply it is live
screen-reader output.

Disclose any attribute-read exception (aria-sort) on a slide. In an accessibility
honesty demo, an undisclosed "we read the DOM here" is a fatal gotcha if a judge
finds it. Disclosing it proactively reinforces the honesty claim.

### Demo roles

- Patrick captures raw tool runs and sets up the live-reveal machine.
- Vishali records the real Orca pass in week 1.
- Jim produces the polished video and deck in week 4.
- Ed presents.

---

## 27. Settled decisions

| Decision | Answer |
|---|---|
| Product name | Usabl |
| AI coding assistant for stop hook | Claude Code (Stop lifecycle event) |
| Target design system | PatternFly v6 |
| Repo | github.com/usabl-dev/usabl (private, Apache-2.0) |
| Stack | TypeScript on Node 22, Vitest, Playwright, axe-core |
| On/off vs observe/advise/gate | On or off. No product modes. |
| notCovered behavior | Block (not advise). Usabl is on or off. |
| Contest timeline | 4 weeks. Week 4 = demo polish. |
| How many PF rules | Eight, with a cut line. |
| Who records real reader | Vishali (Orca on Fedora) |
| Evidence labels | On every Draft from day 1. Contest = all deterministic. |
| Design intake in scope | Interface design yes. Full implementation is a seam. |
| Docs output in scope | Interface design yes. Full generation is a seam. |

### Still to decide

| Decision | Who decides | When |
|---|---|---|
| The demo PatternFly app and the hero bug | Ed + Nitin | Day 1 |
| Real PatternFly repo for smoke pass | Ed | Week 2 |
| Verified-verdict-rate target to state on stage | Vishali + Ed | After measurement |
| CI host for branch protection (private repo needs Team plan) | Ed | Week 2 |
| Real bug sample for rule validation | Nitin + Vishali | Week 1 |

---

## 28. WCAG 2.2 coverage map

This section maps every WCAG 2.2 Level A and Level AA success criterion (56 total)
to what Usabl does about it. This is the honest answer to "how much accessibility
does this tool ensure?"

Categories:

- **Contest (deterministic):** Usabl checks this now, mechanically, and can produce
  `verified` or `regression`.
- **Stretch (deterministic):** Built during the contest if time allows, to prove the
  architecture.
- **Post-contest (deterministic):** Easy to add as a provider. The Page capabilities
  and provider interface support it. We just have not built the provider yet.
- **Advisory (model-judgment):** Usabl can surface a suggestion via the advisory lane
  but cannot verify it mechanically. A person decides.
- **Not applicable:** The criterion does not apply to a rendered web UI component check
  (e.g. time-based media for a PatternFly admin console).
- **Never:** Usabl will never satisfy this. The criterion requires something outside
  the tool's scope (human judgment, application logic, or signal analysis).

### Principle 1: Perceivable

| SC | Name | Level | Usabl | How |
|---|---|---|---|---|
| 1.1.1 | Non-text Content | A | Contest (axe) + Advisory (quality) | axe checks presence of alt/aria-label (deterministic). Advisory lane judges whether the text is actually useful (model-judgment). Design intake can assert exact approved alt text (deterministic). |
| 1.2.1 | Audio-only/Video-only (Prerecorded) | A | Not applicable | PatternFly admin consoles rarely have prerecorded media. If present, this is a content decision outside the component library. |
| 1.2.2 | Captions (Prerecorded) | A | Post-contest | Check for `<track kind="captions">` on video elements. Simple DOM query. |
| 1.2.3 | Audio Description or Media Alternative | A | Not applicable | Same as 1.2.1. |
| 1.2.4 | Captions (Live) | AA | Never | Live captioning is a runtime service decision, not a component property. |
| 1.2.5 | Audio Description (Prerecorded) | AA | Not applicable | Same as 1.2.1. |
| 1.3.1 | Info and Relationships | A | Contest (axe + PF rulepack) | axe checks semantic structure. PF rulepack checks table header association, toolbar labeling, live regions. |
| 1.3.2 | Meaningful Sequence | A | Contest (axe) | axe checks reading order against DOM order. |
| 1.3.3 | Sensory Characteristics | A | Advisory | Requires understanding whether instructions rely on shape/color/location. Model-judgment. |
| 1.3.4 | Orientation | AA | Post-contest | Set viewport to portrait/landscape, assert no content loss. Uses `setViewport`. |
| 1.3.5 | Identify Input Purpose | AA | Contest (axe) | axe checks autocomplete attributes on common input types. |
| 1.4.1 | Use of Color | A | Contest (PF rulepack) | `pf-status-color-only` detects status conveyed by color alone with no text equivalent. axe also partially covers this. |
| 1.4.2 | Audio Control | A | Not applicable | PatternFly admin consoles do not auto-play audio. |
| 1.4.3 | Contrast (Minimum) | AA | Contest (axe) | axe owns color contrast checking. Usabl does not reimplement it. |
| 1.4.4 | Resize Text | AA | Stretch | Set zoom to 200%, assert no content loss or overlap. Uses `setZoom`. One of the two stretch-goal checks. |
| 1.4.5 | Images of Text | AA | Contest (axe) | axe flags images used as text. |
| 1.4.10 | Reflow | AA | Post-contest | Set viewport to 320px CSS width, assert no horizontal scroll. Uses `setViewport`. |
| 1.4.11 | Non-text Contrast | AA | Contest (axe) | axe checks UI component and graphical object contrast. |
| 1.4.12 | Text Spacing | AA | Post-contest | Inject increased spacing via CSS, assert no content loss. Uses `getComputedStyle` + `setViewport`. |
| 1.4.13 | Content on Hover or Focus | AA | Post-contest | Trigger hover/focus content, assert dismissable + hoverable + persistent. Declarative probe. |

### Principle 2: Operable

| SC | Name | Level | Usabl | How |
|---|---|---|---|---|
| 2.1.1 | Keyboard | A | Contest (keyboard walk + PF rulepack) | The keyboard walk tabs through every interactive element. `row-action-reachable` flags clickable-but-unreachable elements. Any interactive element not on the Tab path is reported. |
| 2.1.2 | No Keyboard Trap | A | Contest (keyboard walk) | Cycle detection in the walk. If Tab never escapes a region, the walk reports it. |
| 2.1.4 | Character Key Shortcuts | A | Never | Requires knowing whether single-character shortcuts exist in application logic. |
| 2.2.1 | Timing Adjustable | A | Never | Time limits are application logic. Usabl does not run over time. |
| 2.2.2 | Pause, Stop, Hide | A | Post-contest | Detect auto-updating/moving content and assert a pause mechanism exists. Partially possible with animation detection. |
| 2.3.1 | Three Flashes or Below | A | Never | Seizure detection requires frame-by-frame photosensitivity analysis. A different tool. |
| 2.4.1 | Bypass Blocks | A | Contest (axe) | axe checks for skip links and landmark regions. |
| 2.4.2 | Page Titled | A | Contest (axe) | axe checks document title presence. |
| 2.4.3 | Focus Order | A | Contest (keyboard walk) | The walk records focus order. Focus that jumps illogically is observable in the transcript. PF rulepack checks focus-into-dialog and focus-return. |
| 2.4.4 | Link Purpose (In Context) | A | Advisory | Whether link text is descriptive requires understanding intent. Model-judgment. |
| 2.4.5 | Multiple Ways | AA | Never | Whether there are multiple ways to find a page is an IA decision, not testable per screen. |
| 2.4.6 | Headings and Labels | AA | Contest (axe) + Advisory | axe checks heading structure exists. Whether headings are descriptive is model-judgment. |
| 2.4.7 | Focus Visible | AA | Stretch | Tab through, compare focused vs unfocused computed styles for visible indicator. The second stretch-goal check. |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | Post-contest | At each focus stop, check whether the element is obscured by sticky/fixed positioned elements. Uses `getComputedStyle` + position checks. |
| 2.5.1 | Pointer Gestures | A | Never | Whether multi-point or path-based gestures have single-pointer alternatives is application logic. |
| 2.5.2 | Pointer Cancellation | A | Never | Up-event firing behavior is application logic. |
| 2.5.3 | Label in Name | A | Contest (axe) | axe checks that visible label text is included in the accessible name. |
| 2.5.4 | Motion Actuation | A | Never | Whether motion-triggered actions have alternatives is application logic. |
| 2.5.7 | Dragging Movements | AA | Never | Whether drag operations have non-dragging alternatives is application logic. |
| 2.5.8 | Target Size (Minimum) | AA | Post-contest | Measure bounding boxes of interactive elements, flag below 24x24 CSS px. Uses `getComputedStyle`/bounding box. |

### Principle 3: Understandable

| SC | Name | Level | Usabl | How |
|---|---|---|---|---|
| 3.1.1 | Language of Page | A | Contest (axe) | axe checks for `lang` attribute on `<html>`. |
| 3.1.2 | Language of Parts | AA | Contest (axe) | axe checks `lang` on elements with different language content. |
| 3.2.1 | On Focus | A | Contest (keyboard walk) | The walk observes whether focusing an element triggers unexpected changes. |
| 3.2.2 | On Input | A | Post-contest | Declarative probe: change an input value, assert no unexpected context change. |
| 3.2.3 | Consistent Navigation | AA | Post-contest | Compare nav landmarks across surfaces, flag structural differences. Multi-page check. |
| 3.2.4 | Consistent Identification | AA | Post-contest | Same function = same label across surfaces. Multi-page comparison. |
| 3.2.6 | Consistent Help | A | Post-contest | Check that help mechanisms appear in the same relative order. Multi-page. |
| 3.3.1 | Error Identification | A | Advisory | Whether errors are identified clearly requires semantic understanding of error states. Partially checkable via aria-invalid + aria-describedby. |
| 3.3.2 | Labels or Instructions | A | Contest (axe) | axe checks that form inputs have labels. |
| 3.3.3 | Error Suggestion | AA | Advisory | Whether error messages suggest a fix requires understanding content. Model-judgment. |
| 3.3.4 | Error Prevention (Legal/Financial) | AA | Never | Whether a submission is legal/financial is application context. |
| 3.3.7 | Redundant Entry | A | Never | Whether previously entered info is auto-populated is application logic. |
| 3.3.8 | Accessible Authentication (Minimum) | AA | Never | Authentication flow design is application architecture. |

### Principle 4: Robust

| SC | Name | Level | Usabl | How |
|---|---|---|---|---|
| 4.1.2 | Name, Role, Value | A | Contest (axe + PF rulepack + walk) | The core of what Usabl checks. axe validates ARIA usage. PF rulepack checks PF-specific name/role/value patterns. The walk reads actual name, role, and state from the accessibility tree. |
| 4.1.3 | Status Messages | A | Contest (PF rulepack) | `pf-toast-live-region` checks that status updates reach assistive technology via live regions. |

### Summary

| Category | Count | Percentage of Level A+AA |
|---|---|---|
| **Contest (deterministic)** | 24 | 43% |
| **Stretch (deterministic, if time)** | 2 | 4% |
| **Post-contest (deterministic, buildable)** | 12 | 21% |
| **Advisory (model-judgment, never verified)** | 5 | 9% |
| **Not applicable** (media in admin consoles) | 4 | 7% |
| **Never** (application logic, human judgment) | 9 | 16% |

**What we can say:**

- At contest time: Usabl mechanically verifies 24 of 56 Level A+AA criteria (43%).
  With the two stretch goals, 26 (46%).
- With the post-contest providers built: 38 of 56 (68%).
- With advisory included (surfaced, person decides): 43 of 56 (77%).
- The remaining 13 (23%) are either not applicable to admin consoles (4) or
  fundamentally require application logic or human judgment the tool will never
  replace (9).

**What we do NOT say:**

- "Usabl makes your app WCAG compliant." It does not. Compliance requires all
  criteria including the ones only a human can judge.
- "Usabl covers X% of accessibility." WCAG is not the whole of accessibility.
  The tool verifies what its checks cover, on the screens it checked.

### Stretch goals (prove the architecture)

Two checks built during the contest to prove the provider interface extends without
touching the gate:

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
- Only attempt if the core vertical slice is solid by end of week 2.
- Do NOT add them to the demo fixture oracle. Run on the real-repo smoke pass.
- If they cause any instability, delete them. They are never on the "never cut" list.
- One slide, one sentence in the demo: "We added these in week 3 without touching
  the gate."
