# Adoption model

How developers and teams discover, try, integrate, and expand usabl, and how
contributors join the project. This is an open-source adoption funnel, not a sales
pipeline.

Every command named here is a real command in the current engine (v0.2.1). The
adoption arc a person actually types is:

```
usabl init            scaffold policy drafts (usabl.config.json + usabl.routes.json)
usabl install <one>   wire one integration surface at a time (--overlay | --claude | --ci | --branch-rule)
usabl baseline        draft the accepted accessibility floor (.usabl-evidence.json)
usabl doctor          read-only health check across every wired surface
usabl check           run the local gate (this is the default command)
usabl floor prune     re-arm the floor as debt is paid down (removes and lowers counts)
usabl drift routes    check the route manifest against the app router
```

`init` and `install` are separate generators. `init` writes policy files and wires
nothing. `install` wires exactly one integration per run and enables nothing on its
own. Only `check` mints a verdict.

---

## Brownfield onboarding, step by step

This is the ordered path for adding usabl to an existing app, with every human step
marked. New to the product, start with the [team orientation](team-orientation.html)
for the one-read overview, then follow the steps here. The funnel below explains why
each stage matters; this section is what a team actually types, in order.

### Phase 1: scaffold the policy (human)

1. (human) Confirm the basics: the app runs on a local dev server, the repo is git,
   and Node 22 is available. Install the headless browser the scanner drives with
   `npx playwright install chromium`, then install usabl. The package is not published
   yet, so today this means building the engine from `usabl-dev/usabl` and linking it;
   the generated CI clones and pins that same engine.
2. (automatic, `usabl init`) Drafts `usabl.config.json` and `usabl.routes.json` from
   the working tree. It infers `appBaseUrl` from the Vite port, reads the app router
   for screens, and seeds the interface globs, the wide-impact globs, and the
   guarded-path list. It writes nothing else and refuses to overwrite either file
   without `--force`.
3. (human) Review the two drafts; the routes and globs are drafts, not measured facts.
   One limit to plan for: `init` recognizes self-closing `<Route ... />` entries with
   root-absolute paths, so a `createBrowserRouter` or data-router app starts
   under-mapped. Step 6 surfaces exactly which screens are missing.
4. (human) Merge both files through a normal PR. They are guarded from then on: an edit
   that makes them diverge from the trusted ref forces an `approval_required` verdict
   until a code owner reviews it.

### Phase 2: first contact and fix the map (mostly automatic)

5. (human) Start the dev server, touch an interface file, and run `usabl check` (the
   default command). Mid-task, `usabl check --self-check` gives an advisory pass that
   never blocks.
6. (automatic) The engine maps the changed files to screens, scans them in a real
   browser, and reports. On a brownfield app expect two kinds of noise: real existing
   findings (verdict `regression`, because there is no floor yet) and coverage gaps
   (verdict `not_covered`) for changed files the route map does not know.
7. (human, `usabl drift routes`) Fix the map first, not the app. `drift routes`
   compares `usabl.routes.json` against the live router and lists the screens added or
   removed. Add the missing routes or manual surfaces, by hand or by re-running
   `usabl init --force`, until a typical change produces zero gaps. Each map edit is a
   guarded change, so it goes through PR review.

### Phase 3: baseline the floor (the key human decision)

8. (automatic, `usabl baseline`) Runs a full scan and drafts the accepted floor into
   `.usabl-evidence.json` as a reviewable working-tree diff. It refuses when other
   guarded paths are dirty, when the scan crashed, or when nothing matched the
   interface globs.
9. (human) Review and merge the floor as an `approval_required` accept. After it lands,
   carried debt does not gate. New, unwaived barriers above the floor still do, and so do
    unconfirmed coverage and later edits to the guarded policy files. A barrier that lands
    in headroom the floor still records counts as carried until `usabl floor prune` re-arms
    the floor; usabl discloses that headroom on every run where it exists.
10. (human, optional) Add waivers to `.usabl-waivers.json` for findings that need a
    temporary exception. Each waiver is fully typed and names `rule`, `surface`,
    `scope`, `reason`, `owner`, `approvedBy`, `created`, and `expires` (both timestamps
    ISO-8601 UTC). Expired waivers cover nothing, so the finding gates again on its own.

### Phase 4: install the surfaces (human, one draft per run)

11. (automatic, `usabl install --overlay`) Drafts the advisory Vite plugin so the
    browser inspector appears during development. It refuses to clobber an existing
    config and prints the exact lines to add.
12. (automatic, `usabl install --claude`) Merges a Stop hook running
    `npx usabl stop-hook` into `.claude/settings.json`, so an assistant's first stop on a
    blocking verdict is blocked unless a one-use bypass was issued. Its companion `usabl install --claude-skill`
    writes the on-demand `/usabl-check` skill to `.claude/skills/usabl-check/SKILL.md`,
    so the assistant can run the advisory self-check during work. The engine ships the
    skill body, so the installed command cannot drift from the CLI it calls.
13. (automatic, `usabl install --ci`) Writes the three-job
    `.github/workflows/usabl-gate.yml` draft: `gate-comment` for the sticky PR comment,
    `usabl-policy` for the policy verdict, and `usabl-required`, the aggregate that is red
    unless the accessibility verdict and the policy verdict both pass. Replace the
    `PIN_TO_A_TRUSTED_USABL_COMMIT` sentinel with a full engine SHA. The workflow runs
    `usabl check --ci --trusted-ref origin/<base-ref>`; the trusted ref is what stops a
    PR from rewriting the floor and approving itself, because policy is read from the
    trusted base and the `usabl-policy` job never checks out PR head.
14. (human) Turn on branch protection so the `usabl-required` check is required, then run
    `usabl install --branch-rule`. That target is read-only: it verifies through the
    GitHub API that `main` requires the check and writes nothing. Require `usabl-required`,
    not `usabl-policy`: `usabl-policy` returns success whenever no guarded path diverged, so
    on its own it can be green while an accessibility regression merges.
15. (human, `usabl doctor`) Run the read-only health check across every wired surface.
    It reports each as wired, missing, drifted, or unknown, and always exits 0.

### Phase 5: the daily loop (automatic, humans only when blocked)

16. (automatic) A developer or an assistant changes interface code. The overlay shows
    findings live, the agent can self-check mid-task, and at stop time and PR time the
    same engine runs on just the affected screens and returns one of the four verdicts, or
    none when nothing was checked or the run could not decide.
    `verified` mints a receipt bound to the exact code, and the Stop hook accepts a
    valid receipt without rescanning. `usabl bypass` is a loud, one-time escape that
    lets the next stop skip verification once.
17. (human, when a run says to, `usabl floor prune`) When a floor finding is fixed it shows
    as `fixed` and stops appearing. `floor prune` re-arms the gate on screens that scanned
    cleanly: it removes entries whose identity is gone and lowers the recorded count where
    fewer barriers remain. A run that finds the floor claiming more barriers than are present
    says so and names this command, so you find out on a run rather than having to remember.
    It reports both counts without guessing why they differ: barriers may have been paid
    down, or the page may render fewer rows today. It is a notice and not a block: the
    verdict does not move, and until the floor is re-armed a new barrier at that identity is
    recorded as accepted debt. Merge the floor diff with the fix. The
    floor only ratchets downward with review; it never grows silently.

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
  the verdict, or the no-verdict outcome, with each finding as a what, why, and fix line rather than a JSON dump.
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
deterministic findings as the floor, so from then on carried debt does not gate. What
still gates: a new, unwaived violation above the floor, coverage the run could not confirm, and an edit
to a guarded policy file. Baseline is an explicit, separate step; it never runs during a
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
| **CI gate** | `usabl install --ci` | Writes `.github/workflows/usabl-gate.yml`, a three-job draft (`gate-comment`, `usabl-policy`, and the required `usabl-required` aggregate). The engine ref is left as the `PIN_TO_A_TRUSTED_USABL_COMMIT` sentinel for you to replace with a full commit SHA. | Sticky PR comment plus a fail-closed gate |
| **Dev-server overlay** | `usabl install --overlay` | Wires the advisory Vite plugin into `vite.config.ts`. Writes a draft when no config exists, no-ops when already wired, and refuses to clobber a hand-tuned config. | Advisory findings badge while coding |
| **Assistant hook** | `usabl install --claude` | Wires a Stop hook running `npx usabl stop-hook` into `.claude/settings.json`. | Blocks the first stop on a blocking verdict unless a one-use bypass was issued |
| **Assistant skill** | `usabl install --claude-skill` | Writes the on-demand `/usabl-check` skill to `.claude/skills/usabl-check/SKILL.md`, running the advisory `npx usabl check --self-check`. Writes a draft when absent, no-ops when it matches, and refuses to clobber a differing file. | The assistant can self-check mid-task without leaving the editor |
| **Branch rule** | `usabl install --branch-rule` | Read-only verification through a `gh` GET that branch `main` requires the `usabl-required` status check. Writes nothing. | Confirms the gate is actually enforced |
| **Playwright test** | `usabl/playwright` export | `assertUsablVerdict(result, allowed)` reads a gated Result, checks its verdict against the list you allow, and returns that answer as a `passed` flag with the verdict, the exit code, a summary line, and a scrubbed copy of the Result. Your test asserts on what it returns; the helper itself throws nothing and mints no verdict. | Reuse a check verdict in tests you already run |

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

**Mitigation:** The evidence floor keeps carried debt from gating, so what gates is a new,
unwaived violation above the floor, coverage the run could not confirm, or a guarded policy edit. Editing a guarded
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
| **npm** (`usabl`) | Planned primary install path. Not yet published; today build the engine from source and link it, then run `usabl init` and `usabl check` |
| **GitHub** (`usabl-dev/usabl`) | Source, issues, contributions, releases (Apache-2.0) |
| **GitHub Action draft** | `usabl install --ci` writes the workflow; you pin the engine SHA and require the `usabl-required` check |

No paid tier, no freemium gate, no telemetry-gated features. Apache-2.0.

---

## Adoption metrics (tie to success-metrics.md)

| Stage | Metric | How measured |
|---|---|---|
| Discover | README views, clone count | GitHub Insights |
| Try | First `usabl check` run (anon, opt-in only) | None in contest; future opt-in telemetry decision |
| Integrate | Repos with `usabl.config.json` or the `usabl-gate` CI workflow | GitHub search (public), self-reported (private) |
| Expand | Repos gating on the `usabl-required` check | GitHub search, self-reported |
| Contribute | PRs from non-core contributors | GitHub |

**Contest scope:** Adoption metrics are defined for the post-contest pilot. The contest
submission demonstrates the funnel works on the demo app and one real PatternFly
surface.

---

## Relationship to other docs

- **Start here:** [team orientation](team-orientation.html), the product in one read
- **Try** stage requirements: [ux-policy.md](./ux-policy.md), first-run experience
- **Contribute** stage: `CONTRIBUTING.md` in the repo root (engineering deliverable)
- **Discover** stage README: the quickstart README
- **Expand**: [journeys.md](./journeys.md), Journey 4 (team onboarding)
