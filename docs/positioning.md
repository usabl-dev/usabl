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
For a technical competitor-by-competitor research pass, see
[market-landscape-2026-08.md](../../research/market-landscape-2026-08.md).

---

## Category

**usabl is an accessibility proof engine for AI-assisted UI development.**

Tagline: *usable by default.* Supporting line: *Don't ship until it's usabl.*

Scanners report findings. usabl runs a full proof loop on every change, verifies fixes,
and gates completion until proof passes.

---

## What users get

usabl is an end-to-end accessibility proof system for AI-assisted UI work. Install it,
point it at your dev server, and get a full check on every change - with fix
verification before work is marked done and one clear answer across the whole workflow:
CLI, AI assistant, browser overlay, CI, and docs.

| What users get | What that means for them |
|---|---|
| **Complete change coverage** | Every touched UI surface is identified, exercised, and checked. |
| **Fix verification** | Problems are found and re-checked after the fix, before anyone calls the work finished. |
| **Accessibility announcement preview** | Shows what a screen reader would likely announce, before and after, on the actual change. |
| **Keyboard and interaction proof** | Tab order, focus, and interaction paths are walked, not just static markup rules. |
| **Design-system intelligence** | PatternFly-specific composition rules on top of industry-standard checks. |
| **One answer everywhere** | Same result in the terminal, in the AI session, in the browser, and on the PR. |
| **Team enforcement** | CI, stop hooks, and policy guardrails so accessibility proof is part of shipping. |
| **Ship-ready artifacts** | Alt text, announcements, and keyboard paths generated and tied to the verified change. |

---

## Competitive landscape

Strong tools exist on every axis. No one ships the full integrated loop as a single
product today.

| Category | Examples | What they do well | Where usabl goes further |
|---|---|---|---|
| **Accessibility scanners** | axe, Lighthouse, Pa11y, WAVE | Fast issue lists on a page | Verify the fix, gate completion, cover the full change set |
| **CI regression tools** | Chromatic, Pa11y CI, MFA11y | Block new violations vs baseline | Same ratchet idea, plus AI gate, keyboard walk, SR evidence, PF rules |
| **AI accessibility assistants** | Deque axe MCP, a11y MCP wrappers | Scan and suggest fixes from the agent | Proof before "done"; the assistant does not grade its own homework |
| **Agent enforcement hooks** | Community-Access/accessibility-agents, agent-gates | Block edits until review runs | Per-change deterministic proof loop, not one review per session |
| **Screen reader simulation** | Tactual, Speakable, JAWS Inspect | Announcement preview and diff | Built into the full dev loop: gate, CI, fix verification, PF rules |
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

Four pillars, ranked. Each is an integrated capability no single competitor ships today.

### 1. End-to-end proof loop

Most tools find problems. usabl closes the loop: scan -> fix -> re-verify -> gate -> ship.
The AI cannot declare victory until proof passes on what changed. One pass combines
axe-core, PatternFly composition rules, live keyboard walk, and screen reader
announcement preview with before/after diff.

**Why it matters:** Teams stop shipping "probably fixed" UI.

### 2. AI-native completion gate

The stop hook blocks "I'm done" until proof passes. Mid-task self-check lets the agent
course-correct while context is warm. Same engine, same answer - the AI proposes fixes
but never grades its own work.

**Why it matters:** Accessibility proof is built into how AI builds UI, not bolted on
after the fact.

### 3. Screen reader evidence on the change

Shows what would be announced before and after, attached to the PR and the assistant
session. Reviewers hear accessibility impact alongside visual diff.

**Why it matters:** Screen reader behavior becomes visible team evidence, not a
separate QA pass weeks later.

### 4. One engine, team enforcement

CLI, stop hook, overlay, CI comment, Playwright helper, and docs output all run the
same engine and return the same verdict. Policy changes are tamper-evident. Every
result ties to the exact code state and can be recomputed by anyone.

**Why it matters:** No tool sprawl, no conflicting scores, and standards stay
enforceable as the codebase evolves.

### Also unique (supporting, not headline)

- **PatternFly rulepack** - purpose-built composition rules; empty slot for PF (FluentUI
  has one, PF does not).
- **Full-surface coverage per change** - maps touched surfaces, runs the full stack on
  that set, returns a definitive outcome for the whole change.
- **Receipt-backed results** - audit-ready, re-checkable proof for compliance
  conversations and release confidence.

---

## Messaging

### Elevator

> usabl makes every UI change complete accessibility proof before it ships, from the
> AI session to the PR to CI.

### Vs scanners

> Scanners tell you what's wrong. usabl checks the full change, verifies the fix, and
> won't let work close until proof passes.

### Vs AI tools

> Your AI can write the UI. usabl decides when it's actually usable.

### Vs screen reader simulation tools

> Tactual and Speakable preview announcements. usabl runs that preview inside the full
> proof loop that gates your AI and your merge.

### Innovation / contest angle

> The first open tool that combines AI completion gating, multi-layer accessibility
> proof, differential regression, screen reader evidence on the PR, and
> PatternFly-native rules on one re-checkable result.

---

## What to lead with

Priority order for pitches, demos, and one-pagers:

1. **End-to-end proof loop** - find, fix, verify, gate
2. **AI-native completion gate** - proof before "done"
3. **Screen reader evidence on the change** - before/after on the PR
4. **One engine, team enforcement** - same result everywhere, tamper-evident

---

## Related document types

| Term | Typical use |
|---|---|
| **Positioning document** (this doc) | Who we are, what category we own, how we differ, how we talk about it |
| **Competitive landscape / analysis** | Deeper research on competitors and market gaps ([market-landscape-2026-08.md](../../research/market-landscape-2026-08.md)) |
| **Battlecard** | Competitive positioning: us vs a class of tools, what we add |
| **Adoption model** | How users discover, try, integrate, expand, and contribute ([adoption-model.md](./adoption-model.md)) |
| **Value proposition** | User outcomes and proof points; often folded into positioning |
| **Ground truth** | Internal build spec and contracts ([ground-truth.md](./ground-truth.md)) |
