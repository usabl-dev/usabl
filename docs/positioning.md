# usabl: product positioning

This is usabl's **positioning document** (also called a *positioning brief* in product
management). It states what we deliver, how we compare to alternatives, and how to
talk about the product with users, judges, and the open-source community.

usabl is an open-source project (Apache-2.0). There is no paid tier. Adoption is
self-serve: install, run, integrate. Community contribution is part of the product
strategy, not a nice-to-have.

For build contracts, verdict semantics, and architecture, see [ground-truth.md](./ground-truth.md).
For pitch lines by audience, see [message-house.md](./message-house.md).
For competitor Q&A, see [battlecards.md](./battlecards.md).
For a technical competitor-by-competitor research pass, see the internal
market-landscape research (August 2026, maintained outside this repository).

---

## Category

**usabl is an accessibility proof engine for AI-assisted UI development.**

Tagline: *usable by default.* Supporting line: *Don't ship until it's usabl.*

usabl runs a proof loop on every change and verifies fixes. Its Stop hook blocks the
first stop on a blocking verdict unless a one-use bypass was issued.

---

## What users get

usabl checks each UI change for new deterministic, machine-checkable accessibility
barriers on the screens it maps and scans, and discloses every gap it detects. Install
it, point it at your dev server, and the same gate runs from the CLI, the AI assistant's
Stop hook, and CI; the browser overlay shows the same local result without blocking. It
does not prove completeness, readiness to ship, or compliance.

| What users get | What that means for them |
|---|---|
| **Change coverage with honest gaps** | Changed UI files are mapped to screens, and those screens are exercised and checked. A changed file usabl cannot map to a screen is reported as not_covered, and every gap it detects is disclosed. |
| **Fix verification** | Problems are found and re-checked after the fix; the Stop hook blocks the assistant's first stop on a blocking verdict unless a one-use bypass was issued. |
| **Screen-reader announcement checks** | Deterministically verifies the accessible names and announcement expectations screen reader users depend on, on the actual change. |
| **Keyboard and interaction proof** | Tab order, focus, and interaction paths are walked, not just static markup rules. |
| **Design-system intelligence** | PatternFly-specific composition rules on top of industry-standard checks. |
| **One answer everywhere** | The terminal, the AI session, and the browser overlay show the same local Result. CI reads policy from the trusted base, so its result can differ when local policy files differ. |
| **Team enforcement** | CI, stop hooks, and policy guardrails so accessibility proof is part of shipping. |
| **Evidence artifacts** | Findings with fix guidance, plus a re-checkable evidence page (JSON or HTML) tied to the verified change. |

---

## Competitive landscape

Strong tools exist on every axis. usabl's design goal is the full integrated loop as a
single product; this section does not claim what other tools do or do not ship.

| Category | Examples | What they do well | What usabl is built to add |
|---|---|---|---|
| **Accessibility scanners** | axe, Lighthouse, Pa11y, WAVE | Fast issue lists on a page | Verify the fix, block the assistant's first stop on a blocking verdict unless bypassed, cover the screens a change maps to and disclose the gaps |
| **CI regression tools** | Chromatic, Pa11y CI, MFA11y | Block new violations vs baseline | Same ratchet idea, plus AI gate, keyboard walk, SR evidence, PF rules |
| **AI accessibility assistants** | Deque axe MCP, a11y MCP wrappers | Scan and suggest fixes from the agent | Proof before "done"; the gate decides and the assistant only proposes |
| **Agent enforcement hooks** | Community-Access/accessibility-agents, agent-gates | Block edits until review runs | Per-change deterministic proof loop, not one review per session |
| **Screen reader simulation** | Tactual, Speakable, JAWS Inspect | Announcement preview and diff | Deterministic announcement and accessible-name checks wired into the gated loop: CI, fix verification, PF rules |
| **Design-system lint** | FluentUI eslint plugin | Component-level static rules | Runtime interaction, keyboard walk, and proof engine; PatternFly-native |
| **Commercial verification** | Jeikin, Evinced | Enterprise dashboards and flows | Open, integrated loop from AI session to merge |

---

## Market scope

PatternFly is the first instantiation. The architecture is **check-agnostic**: the gate,
verdict, receipt, and surface model work with any provider that returns `Draft[]`. Any
design system, any rulepack, any rendered-DOM check can plug in.

**Addressable audience:** Every team using AI to build UI - and every team that ships
UI into regulated or enterprise environments where accessibility evidence matters.
PatternFly teams at Red Hat are first adopters; the engine generalizes.

---

## What is innovative

Four pillars, ranked. Each is a design goal of the product, stated without claims about other tools.

### 1. End-to-end proof loop

usabl is built to close the loop: scan -> fix -> re-verify -> gate -> ship.
The Stop hook blocks the AI's first stop on a blocking verdict unless a one-use bypass was issued. One pass combines
axe-core, PatternFly composition rules, a live keyboard walk, and deterministic
screen-reader announcement checks on what changed.

**Why it matters:** Teams get a re-checked answer on the screens mapped from the files they changed instead of
a "probably fixed".

### 2. AI-native completion gate

The stop hook blocks the first "I'm done" on a blocking verdict unless a one-use bypass
was issued; idle, no verdict, and hook errors are disclosed and allowed. Mid-task self-check lets the agent
course-correct while context is warm. The same engine runs locally and in CI, though CI
reads policy from the trusted base; the AI proposes fixes but never grades its own work.

**Why it matters:** Accessibility proof is built into how AI builds UI, not bolted on
after the fact.

### 3. Screen-reader announcement checks on the change

usabl deterministically checks the accessible names and announcement expectations that
screen reader users depend on, and attaches the findings to the PR and the assistant
session. Reviewers see screen-reader impact alongside the visual diff. usabl does not
speak the UI or replace assistive-technology testing.

**Why it matters:** Screen-reader barriers become visible team evidence in the loop,
not a separate QA pass weeks later.

### 4. One engine, team enforcement

CLI, stop hook, overlay, CI comment, and docs output all run the same engine and read
the gate's Result. The Playwright helper runs the same providers but returns a separate
page-level result with no floor and no waivers, so its verdict can differ. Policy changes
are tamper-evident. A verified result ties to the exact code state and can be re-checked
by anyone.

**Why it matters:** One engine behind every surface, and standards stay enforceable as
the codebase evolves.

### Also part of the design (supporting, not headline)

- **PatternFly rulepack** - purpose-built composition rules for the design system our
  products use.
- **Coverage per change** - maps changed UI files to screens, runs the full stack on that set,
  and returns one of four verdicts, or none, for the whole change, with any surface it cannot reach flagged
  as not_covered.
- **Receipt-backed verified results** - each verified change carries a re-checkable
  receipt: evidence for compliance conversations. It does not claim compliance.

---

## Messaging

### Elevator

> usabl proves that a UI change added no new unwaived machine-checkable accessibility
> barrier on the screens it scanned, and discloses every gap it detected, from the AI
> session to the PR to CI.

### Vs scanners

> usabl checks the screens mapped from a change's UI files, verifies the fix, and blocks the first
> stop on a blocking verdict unless a one-use bypass was issued.

### Vs AI tools

> Your AI can write the UI. usabl decides whether the change added a new unwaived
> machine-checkable barrier on the screens it scanned.

### Vs screen reader simulation tools

> Tactual and Speakable preview announcements. usabl runs deterministic announcement
> and accessible-name checks inside the proof loop whose Stop hook blocks the assistant's
> first stop on a blocking verdict unless a one-use bypass was issued, and whose required
> check blocks the normal merge path.

### Innovation / contest angle

> An open tool that combines AI completion gating, multi-layer accessibility
> proof, differential regression, deterministic screen-reader announcement checks on the
> PR, and PatternFly-native rules, with a re-checkable receipt when the change verifies.

---

## What to lead with

Priority order for pitches, demos, and one-pagers:

1. **End-to-end proof loop** - find, fix, verify, gate
2. **AI-native completion gate** - proof before "done"
3. **Screen-reader announcement checks on the change** - accessible names and announcements on the PR
4. **One engine, team enforcement** - one engine behind every surface, tamper-evident

---

## Related document types

| Term | Typical use |
|---|---|
| **Positioning document** (this doc) | Who we are, what category we own, how we differ, how we talk about it |
| **Competitive landscape / analysis** | Deeper research on competitors and market gaps (internal market-landscape research, August 2026) |
| **Battlecard** | Competitive positioning: us vs a class of tools, what we add |
| **Adoption model** | How users discover, try, integrate, expand, and contribute ([adoption-model.md](./adoption-model.md)) |
| **Value proposition** | User outcomes and proof points; often folded into positioning |
| **Ground truth** | Internal build spec and contracts ([ground-truth.md](./ground-truth.md)) |
