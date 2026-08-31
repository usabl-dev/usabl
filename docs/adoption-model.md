# Adoption model

How developers and teams discover, try, integrate, and expand usabl, and how
contributors join the project. This is an open-source adoption funnel, not a sales
pipeline.

Every command named here is a real command in the current engine (v0.2.0). The
adoption arc a person actually types is:

```
usabl init            scaffold policy drafts (usabl.config.json + usabl.routes.json)
usabl install <one>   wire one integration surface at a time (--overlay | --claude | --ci | --branch-rule)
usabl baseline        draft the accepted accessibility floor (.usabl-evidence.json)
usabl doctor          read-only health check across every wired surface
usabl check           run the local gate (this is the default command)
usabl floor prune     re-arm the floor as debt is paid down
usabl drift routes    check the route manifest against the app router
```

`init` and `install` are separate generators. `init` writes policy files and wires
nothing. `install` wires exactly one integration per run and enables nothing on its
own. Only `check` mints a verdict.

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

**Goal:** Understand what usabl is in 30 seconds.

**What they need:**

- README with a one-sentence thesis and a quickstart
- A "What is this?" section that positions against familiar tools (axe, Lighthouse)
  in two sentences, not a wall of text
- A live or recorded demo link (THE MOMENT)

**Friction risk:** README too long, too academic, or too Red-Hat-internal. It must
read as a useful open tool, not a contest entry.

**Success signal:** Clones the repo, or runs `npx usabl init` followed by
`usabl check` on a demo app.

---

## 2. Try

**Who:** Engineer who cloned the repo or installed the package.

**Trigger:** Ran `usabl init` and then `usabl check`.

**Goal:** First real finding on their own code in a few minutes.

**What they need:**

- `usabl init` to scaffold policy. It inspects the working tree, infers `appBaseUrl`
  from the Vite config port, reads the app router for `<Route>` entries, and writes
  `usabl.config.json` and `usabl.routes.json` as reviewable drafts. It refuses to
  overwrite either file without `--force`, and it writes nothing else. The routes and
  surfaces are drafts to review, not measured facts.
- `usabl check` as the first gate. `check` is the default command, so `usabl` with no
  positional runs it. It loads config, runs the deterministic providers, and prints
  one verdict with each finding as a what, why, and fix line rather than a JSON dump.
  `--json` is available for machine output.
- Exit-code semantics so it works in scripts from run one: 0 for verified or idle,
  1 for a regression, 2 for approval required or a refusal, 3 for not covered, 4 for a
  crash. The finding output already carries the "what just happened" explanation, so no
  separate explain flag is needed.

**Friction risk:**

- Playwright browser is missing or slow to install (document
  `npx playwright install chromium` as a prerequisite; the engine drives Chromium
  through Playwright)
- No config yet, so `check` has nothing to load (this is why `init` comes first)
- Too many findings on a legacy app, which feels noisy before the floor is set

**Mitigation:** `usabl baseline` drafts the accepted accessibility floor into
`.usabl-evidence.json` as a reviewable working-tree diff. It captures the current
deterministic findings as the floor, so from then on carried debt does not gate and
only new violations do. Baseline is an explicit, separate step; it never runs during a
check.

**Success signal:** Reads a finding and says "yeah, that's real."

---

## 3. Integrate

**Who:** Engineer or team lead who saw real findings and wants continuous signal.

**Trigger:** Trusted the first few results and wants it in the daily workflow.

**Goal:** Running in CI, in the dev-server overlay, or in the assistant hook with
minimal setup.

Each integration is wired with `usabl install`, which takes exactly one target flag
per run and writes a draft. Nothing is enabled until you review the draft and, for CI,
pin the engine and turn on branch protection.

| Entry point | Command | What it wires | Value |
|---|---|---|---|
| **CI gate** | `usabl install --ci` | Writes `.github/workflows/usabl-gate.yml`, a two-job draft (`gate-comment` and the required `usabl-policy` check). The engine ref is left as the `PIN_TO_A_TRUSTED_USABL_COMMIT` sentinel for you to replace with a full commit SHA. | Sticky PR comment plus a fail-closed gate |
| **Dev-server overlay** | `usabl install --overlay` | Wires the advisory Vite plugin into `vite.config.ts`. Writes a draft when no config exists, no-ops when already wired, and refuses to clobber a hand-tuned config. | Advisory findings badge while coding |
| **Assistant hook** | `usabl install --claude` | Wires a Stop hook running `npx usabl stop-hook` into `.claude/settings.json`. | Blocks an assistant "done" on a blocking verdict |
| **Branch rule** | `usabl install --branch-rule` | Read-only verification through a `gh` GET that branch `main` requires the `usabl-policy` status check. Writes nothing. | Confirms the gate is actually enforced |
| **Playwright test** | `usabl/playwright` export | `assertUsablVerdict(result, allowed)` asserts a gated Result's verdict inside an existing Playwright suite. It reads a Result; it never mints one. | Reuse a check verdict in tests you already run |

After wiring, `usabl doctor` gives a read-only projection of every surface and reports
each as wired, missing, drifted, or unknown. It always exits 0 because it mints no
verdict.

**Friction risk:**

- The overlay and CI drafts need review before they take effect, so there is a small
  setup step per surface
- CI can gate on legacy debt if you skip `usabl baseline`
- The assistant hook is Claude-specific today; only the Claude Code Stop hook is wired

**Mitigation:** `usabl init` infers routes and surfaces from the app router, so mapping
starts from real code rather than a blank file. `usabl baseline` sets the floor so the
CI gate starts from the current accepted level, not from zero. `usabl doctor` shows
exactly what is wired before anyone relies on it.

**Success signal:** The gate runs on every PR, and the hook or overlay runs in the
daily loop, without manual invocation.

---

## 4. Expand

**Who:** Team lead rolling out across repos, or an individual moving from CI to the
assistant loop.

**Trigger:** The signal is trusted, and the team wants enforcement or wider coverage.

**Goal:** Roll out to more repos, onboard teammates, and manage existing debt.

**What they need:**

- A clear floor-acceptance path for legacy surfaces: `usabl baseline` per repo, with
  the resulting `.usabl-evidence.json` reviewed like any other change
- The waiver ledger `.usabl-waivers.json` for known debt. Each waiver is fully typed
  and carries an `expires` field (validated ISO-8601 UTC), so a waiver ages out on a
  date rather than lingering forever
- `usabl floor prune` to re-arm the floor. It removes paid-down entries only from
  screens that scanned cleanly with no gaps, so fixing a barrier tightens the gate
- `usabl drift routes` to catch the route manifest drifting from the app router
- Team documentation on what the verdicts mean and who can change policy

**Friction risk:**

- Legacy surfaces block immediately when the floor is skipped
- Policy changes are unclear, so someone edits guarded files quietly
- No shared view of progress, so the effort loses visibility

**Mitigation:** The evidence floor means only new violations gate. Editing a guarded
policy file (`usabl.config.json`, `usabl.routes.json`, `.usabl-evidence.json`,
`.usabl-waivers.json`) so it diverges from the trusted ref forces an
`approval_required` verdict, so acceptance bytes cannot be self-approved in the same
change. Waiver expiry burns debt down on a schedule, and `usabl floor prune` records
each paid-down barrier.

**Note on fleet reporting:** A measurement-only fleet-insights module is built and
published behind the `./measure` package export, but it is dormant. It is not part of
the run or gate path and does not affect any verdict. Treat cross-repo fleet reporting
as a future capability, not a current one.

**Success signal:** Multiple repos gating; the false-positive rate stays stable; debt
burns down through waiver expiry and floor prune.

---

## 5. Contribute

**Who:** Engineer who wants to add a rule, fix a bug, write a provider, or propose a
PatternFly rulepack addition.

**Trigger:** Hit a limitation ("why doesn't it check X?"), found a bug, or wants their
design system supported.

**Goal:** The contribution lands without heroics.

**What they need:**

- CONTRIBUTING.md with an architecture overview and "where to start" pointers
- The provider interface documented: write a provider, return `Draft[]`, and the gate
  turns those drafts into findings with identity and status
- A rulepack extension guide: an "add a PatternFly rule" tutorial
- Clear issue labels: `good-first-issue`, `rulepack`, `provider`, `bug`
- A stated review-turnaround commitment

**Friction risk:**

- Architecture too complex to enter, so the contributor gives up
- A PR sits unreviewed, so the contributor leaves
- The rulepack feels like an internal project rather than a community one

**Mitigation:** The provider interface is the contribution seam. Adding a check means
returning `Draft[]`; it does not require understanding the gate, because the gate owns
identity and verdicts and providers only report evidence. The PatternFly rulepack is
proposed upstream for co-maintenance.

**Success signal:** An external contributor lands a rule or provider, and the
PatternFly team accepts the upstream rulepack proposal.

---

## OSS distribution model

| Channel | Purpose |
|---|---|
| **npm** (`usabl`) | Primary install path; run `npx usabl init` then `usabl check` |
| **GitHub** (`usabl-dev/usabl`) | Source, issues, contributions, releases (Apache-2.0) |
| **GitHub Action draft** | `usabl install --ci` writes the workflow; you pin the engine SHA and require the `usabl-policy` check |

No paid tier, no freemium gate, no telemetry-gated features. Apache-2.0.

---

## Adoption metrics (tie to success-metrics.md)

| Stage | Metric | How measured |
|---|---|---|
| Discover | README views, clone count | GitHub Insights |
| Try | First `usabl check` run (anon, opt-in only) | None in contest; future opt-in telemetry decision |
| Integrate | Repos with `usabl.config.json` or the `usabl-gate` CI workflow | GitHub search (public), self-reported (private) |
| Expand | Repos gating on the `usabl-policy` check | GitHub search, self-reported |
| Contribute | PRs from non-core contributors | GitHub |

**Contest scope:** Adoption metrics are defined for the post-contest pilot. The contest
submission demonstrates the funnel works on the demo app and one real PatternFly
surface.

---

## Relationship to other docs

- **Try** stage requirements: [ux-policy.md](./ux-policy.md), first-run experience
- **Contribute** stage: `CONTRIBUTING.md` in the repo root (engineering deliverable)
- **Discover** stage README: the quickstart README
- **Expand**: [journeys.md](./journeys.md), Journey 4 (team onboarding)
