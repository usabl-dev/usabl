# Adoption model

Status: working draft. Author: eparenti. August 2026.

How developers and teams discover, try, integrate, and expand Usabl - and how
contributors join the project. This is an open-source adoption funnel, not a sales
pipeline.

For adoption ladder mechanics (observe -> advise -> gate), see
[ux-policy.md](./ux-policy.md) § Adoption ladder.

---

## The funnel

```
Discover -> Try -> Integrate -> Expand -> Contribute
```

Each stage has a trigger, a goal, a friction risk, and a success signal.

---

## 1. Discover

**Who:** Engineer sees a finding in a PR, hears about it at a conference, hits the
README from a search, or sees the rulepack referenced in a PatternFly issue.

**Trigger:** Pain (accessibility audit surprise, failed 508 review, broken screen
reader report) or curiosity (saw the demo, read the research).

**Goal:** Understand what Usabl is in 30 seconds.

**What they need:**

- README with one-sentence thesis + quickstart command
- "What is this?" section that positions against familiar tools (axe, Lighthouse) in
  two sentences, not a wall of text
- A live or recorded demo link (THE MOMENT)

**Friction risk:** README too long, too academic, or too Red-Hat-internal. Must read
as "useful open tool" not "contest entry."

**Success signal:** Clones the repo or runs `npx usabl check` on their own project.

---

## 2. Try

**Who:** Engineer who cloned the repo or installed the package.

**Trigger:** Ran the quickstart command.

**Goal:** First finding on their own code in under five minutes.

**What they need:**

- Zero-config default: `npx usabl check --url <their-dev-server>` works without a
  surface map, config file, or mapping ceremony
- Clear output: one finding with what/why/fix, not a JSON dump
- Exit code semantics: 0 = verified or idle, 1 = regression, so it works in scripts
  immediately
- "What just happened" explainer in the output footer or `--explain` flag

**Friction risk:**

- Playwright install fails or takes too long (document: `npx playwright install
  chromium` as prerequisite, or bundle in postinstall)
- No finding on their app because the default check set is too narrow -> feels useless
- Too many findings on a legacy app -> feels noisy before they trust it

**Mitigation:** First run defaults to observe (report, never block). Noise budget
applies from run one.

**Success signal:** Reads a finding and says "yeah, that's real."

---

## 3. Integrate

**Who:** Engineer or team lead who saw real findings and wants continuous signal.

**Trigger:** Trusted the first few results; wants it in the daily workflow.

**Goal:** Running in CI, dev-server overlay, or assistant hook with minimal setup.

**What they need (progressive, choose your entry):**

| Entry point | Setup cost | Value |
|---|---|---|
| **CI only** | Add GitHub Action + `usabl check` in workflow | PR comments, ratchet | 
| **Overlay** | Dev-server plugin or proxy | Real-time findings while coding |
| **Assistant hook** | Drop hook config into Claude Code / Cursor | Gate on AI completion |
| **Playwright test** | One assertion in existing test suite | Same check in CI tests already run |

**Friction risk:**

- Surface map required for full coverage -> initial mapping tax
- CI blocks on legacy debt -> configure observe or baseline first
- Hook config is assistant-specific -> document for top 2–3 assistants

**Mitigation:** Storybook auto-discovery reduces mapping tax. Ratchet starts from
current baseline (existing debt = known, not blocking). Hook docs are first-class.

**Success signal:** Harness runs on every PR or every assistant session without manual
invocation.

---

## 4. Expand

**Who:** Team lead rolling out across repos, or individual expanding from CI to
assistant loop.

**Trigger:** Signal is trusted; want enforcement or wider coverage.

**Goal:** Move from observe -> advise -> gate; add more surfaces; onboard teammates.

**What they need:**

- Adoption ladder with clear triggers (see ux-policy.md)
- Fleet evidence view across repos (even static seed for now)
- Waiver ledger for debt management during transition
- Team documentation: what each mode means, who can change policy

**Friction risk:**

- Gate on legacy surfaces -> immediate noise revolt
- Policy change unclear -> someone disables quietly
- No executive visibility -> "why are we doing this?"

**Mitigation:** Ratchet (new only); `approval_required` on policy changes; fleet tile
shows blocked regressions as positive signal.

**Success signal:** Multiple repos in gate mode; false positive rate stable; debt
burning down via waiver expiry.

---

## 5. Contribute

**Who:** Engineer who wants to add a rule, fix a bug, write a provider, or propose a
PF rulepack addition.

**Trigger:** Hit a limitation ("why doesn't it check X?"), found a bug, or wants
their design system supported.

**Goal:** Contribution lands without heroics.

**What they need:**

- CONTRIBUTING.md with architecture overview and "where to start" pointers
- Provider interface documented: "write a provider, return `Draft[]`, ship a check"
- Rulepack extension guide: "add a PatternFly rule" tutorial
- Clear issue labels: `good-first-issue`, `rulepack`, `provider`, `bug`
- Review turnaround commitment (stated, not implied)

**Friction risk:**

- Architecture too complex to enter -> contributor gives up
- PR sits unreviewed -> contributor leaves
- Rulepack is "our thing" not "community thing" -> no upstream proposal lands

**Mitigation:** Provider interface is the contribution seam - adding a check does not
require understanding the gate. PF rulepack proposed upstream to PatternFly org for
co-maintenance.

**Success signal:** External contributor lands a rule or provider. PF team reviews and
accepts upstream rulepack proposal.

---

## OSS distribution model

| Channel | Purpose |
|---|---|
| **npm** (`usabl`) | Primary install path; `npx usabl check` works immediately |
| **GitHub** (`usabl-dev/usabl`) | Source, issues, contributions, releases |
| **GitHub Action** | CI integration as a one-line workflow addition |
| **MCP registry** (if applicable) | Discoverability for assistant users |

No paid tier, no freemium gate, no telemetry-gated features. Apache-2.0.

---

## Adoption metrics (tie to success-metrics.md)

| Stage | Metric | How measured |
|---|---|---|
| Discover | README views, clone count | GitHub Insights |
| Try | First `usabl check` run (anon, opt-in only) | None in contest; future opt-in telemetry decision |
| Integrate | Repos with `.usabl/` config or CI workflow | GitHub search (public), self-reported (private) |
| Expand | Repos in gate mode, fleet size | Fleet evidence, self-reported |
| Contribute | PRs from non-core contributors | GitHub |

**Contest scope:** Adoption metrics are defined for post-contest pilot. Contest
submission demonstrates the funnel works on the demo app and one real PF surface.

---

## Relationship to other docs

- **Try** stage requirements -> [ux-policy.md](./ux-policy.md) § First-run experience
- **Integrate** stage ladder -> [ux-policy.md](./ux-policy.md) § Adoption ladder
- **Contribute** stage -> `CONTRIBUTING.md` in repo root (engineering deliverable)
- **Discover** stage README -> Quickstart README (engineering §7)
- **Expand** -> [journeys.md](./journeys.md) § Journey 4 (team onboarding)
