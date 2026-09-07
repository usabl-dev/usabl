# usabl

![Version](https://img.shields.io/badge/version-0.2.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-team%20preview-orange?style=flat-square)

**usable by default.**

usabl is an accessibility proof engine for product development. It checks that a change adds no new machine-checkable accessibility barriers on the surfaces it touched. In CI, a required check blocks the merge on a blocking verdict. In an assistant, its Stop hook blocks the first attempt to stop on a blocking verdict (regression, not covered, or approval required) unless the user has issued a one-use bypass; idle runs, runs with no verdict, and hook errors are disclosed and allowed. A run that checked something returns one of four verdicts: verified, regression, not covered, or approval required. A run can also return no verdict: the change touched no covered surface (idle), or the run could not produce a verdict (a crash, or every affected screen failing to render). No verdict is not a pass. The scope is accessibility aligned with WCAG 2.2 AA. Screen-reader announcement is the differentiating layer, not the whole claim.

> **The AI can suggest fixes. It does not get to grade its own work.**

## Why usabl

usabl is built to decide whether a change may be called done, rather than to produce a report:

- **A verdict with a receipt.** Only a verified run counts as proof. A verified run mints a receipt you can re-check later against the same source tree, policy hash, engine version, and scanner versions.
- **One engine behind every surface.** The same engine runs behind the CLI, the Stop hook, the dev-server overlay, and CI. The overlay is advisory. CI reads policy from the trusted base branch, so a local run and a CI run can differ when local policy files differ from the base.
- **Honest by construction.** The engine keeps verified, not covered, and merely observed apart in words, never by color. It never claims compliance, and it says so on its own output.
- **Debt that only shrinks.** Known barriers sit in a reviewed evidence floor, recorded by screen, rule, and element identity. Exceptions live in a separate waiver ledger, where each waiver carries an owner, an approver, a reason, and an expiry date. New barriers block. `usabl floor prune` removes floor entries that a full scan no longer observes, so a reintroduced barrier gates as new.

## The four verdicts

A `usabl check` that checked something ends in one of four verdicts, each with a matching exit code:

| Verdict               | Meaning                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Verified**          | No new gating barriers on the touched surfaces, and no coverage gap was detected. A receipt is minted.  |
| **Regression**        | A new machine-checkable barrier appeared. The change is blocked.                                         |
| **Not covered**       | usabl detected a touched surface it could not check, so it refuses to guess. This is honest uncertainty, not a pass. |
| **Approval required** | The change edits policy itself, which needs a human code-owner decision before it can land.              |

Two outcomes carry no verdict. The `verdict` field is `null` and no receipt is minted:

| Outcome     | Meaning                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idle**    | No changed file maps to a covered screen or documentation page, so there was nothing to check. Exit 0. This is not a pass; nothing was measured.                                              |
| **No verdict** | The run could not produce a verdict: an unhandled error, or every affected screen failed to render. Exit 4, and the reason is printed. Not a pass. Two configuration cases differ: if the working-tree `usabl.config.json` cannot be read when the command starts, the command stops before the engine runs, prints the error, and exits 4 with no result at all; in a `--trusted-ref` run where the working-tree config diverged, a trusted-ref copy that is missing, malformed, or unreadable becomes a coverage gap: the overall verdict is `approval_required` (exit 2), the accessibility sub-result is `not_covered` (exit 3), and a result is present. If the guard itself fails to read the trusted ref, the run returns no verdict, exit 4, with a result. |

Only the gate mints a verdict. Every other command drafts, inspects, wires, or reports.

## How it works

- **Deterministic checks.** Three layers run on every application scan: general accessibility rules through axe-core, PatternFly composition rules, and a keyboard and announcement walk. No layer asks a model to judge pass or fail.
- **One gate, several surfaces.** The gate runs behind a Claude Stop hook, a CI gate, and an advisory dev-server overlay. The library ships those integrations as subpath exports (`usabl/vite`, `usabl/playwright`, `usabl/docs`). The overlay projects the gate's result and never mints one. It runs inside the tested page's own JavaScript, so the page can interfere with what it shows; the terminal command and CI are the verdict authority.
- **Playwright page check.** `checkPage(page)` from `usabl/playwright` runs the same providers on one live page and returns a page-level result. It has no evidence floor and no waivers, so a barrier the gate has already accepted still reads as a regression there. Its verdict can differ from `usabl check`.
- **App and docs.** When a `usabl.docs.json` manifest is present, the same engine also scans the product's published documentation pages in the same run, which ends in one verdict or none. The rule profile differs: PatternFly rules do not run on docs pages, a docs rulepack runs only on docs pages, and axe uses the WCAG 2.2 A and AA tag set on docs pages.
- **Coverage identity.** usabl records which changed files map to which screen, and it proves it scanned the address it was configured or discovered to scan. It cannot prove that an address showed the screen a reader expects: a redirect, a signed-out state, or a feature flag can change what an address renders. An optional `reachedWhen` selector adds partial evidence that the expected element was present. A manual surface entry is an operator assertion, not evidence.
- **Receipts bound to the code.** A verified result mints a receipt tied to the exact source tree, the committed policy, the runner version, and the scanner versions. Change any of them and it no longer verifies.
- **AI proposes, the gate decides.** The assistant can suggest and apply fixes, then it must re-run the same gate. It cannot approve its own work. Page text handed to the assistant sits inside a labeled frame that marks it as data rather than instructions. The frame delimiters are removed from page text, so a page cannot close its own frame. Control sequences are stripped and credential-shaped values are redacted before page text leaves the engine.

## Quick start

usabl targets Node 22 and is not yet published to a package registry, so build it from source:

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
npm install        # also installs the shared git hooks
npm run build      # builds dist/ and the usabl CLI
npm run check      # optional: typecheck, tests, build, and a package smoke test
```

To watch the full loop end to end, from a live barrier through a blocked assistant to a verified receipt, follow the [team demo runbook](https://github.com/usabl-dev/usabl-app/blob/main/README.md) in the companion fixture app. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete development setup, including pre-commit.

## Scanning a signed-in application

Most applications worth gating sit behind a login. usabl scans signed out unless you give it a session, and a signed-out scan of a login-gated screen measures the sign-in page or an empty redirect, not your product.

Export a [Playwright storage state](https://playwright.dev/docs/auth) file and point `USABL_STORAGE_STATE` at it:

```bash
export USABL_STORAGE_STATE="$HOME/.usabl/my-app-session.json"
usabl doctor   # confirms a session is configured
usabl check
```

usabl reads the variable once, where it builds its dependencies, so every surface picks up the same session: the CLI, the Vite overlay, and the Claude Stop hook. It is an environment variable rather than a flag because the overlay and the Stop hook have no command line, and rather than a config field because the file holds live cookies and tokens. usabl does not write the path or the file into its config, its evidence files, or its output.

If the variable names a file usabl cannot read, a file that is not JSON, or a session with nothing left in it that could authenticate, the run stops with an error instead of quietly scanning signed out. It stops before it opens a browser and returns no verdict. usabl prints neither the path nor the contents, in errors or in reports. That last check is deliberately strict: it refuses only when every cookie is dated, every date is past, there is no local storage or IndexedDB, and there are no stored credentials, because a false refusal would stop a working run.

Reading the file cannot tell you much beyond that. A token in local storage or IndexedDB carries no expiry, a passkey has none either, and your application can end a session before its cookie says so, so a file that looks live can still be dead. The rest is caught at scan time, on the page itself. A screen is reported as not reached when the application's own data requests come back 401, when a password field is present anywhere in it, or when the browser ended somewhere else that asks for a password. Any of those makes that screen a coverage gap: it contributes no findings, records no keyboard walk, and no barrier on your evidence floor can be reported as resolved from it. A run whose screens were all like that reports `not_covered`, never `verified`.

Two of those rules can be steered. Only 401s from your `appBaseUrl` hostname count, or any subdomain of it, on any scheme and any port, so a third-party service with its own stale credentials cannot block a scan; if usabl cannot parse your `appBaseUrl` it counts every one, because a base URL it cannot read is a configuration it cannot reason about. And a `reachedWhen` selector on a surface, once it matches, outranks the password-field rule, which is how a genuine change-password screen stays scannable. A same-host 401 is never overridden.

Make `reachedWhen` name content only that screen has, such as its own table or heading. It is your assertion, not a proof usabl can check: a selector aimed at a shell, header, navigation, or footer matches your sign-in page too, and would quietly let a wrong page pass as the screen.

None of this is complete. A sign-in page that makes no API calls and shows no password field, such as a passkey or magic-link prompt, is still not caught. Declare a `reachedWhen` selector on a surface when you want a positive assertion that the screen loaded rather than a heuristic that it did not. The [ground truth](docs/ground-truth.md) states exactly what is closed and what is not, including one residual worth knowing now: a credential written into a surface URL in your own `usabl.config.json` is echoed verbatim by every surface, so do not put one there.

## Command surface

These commands draft, inspect, wire, and report. Only `usabl check` decides a verdict.

| Command                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usabl check`                         | The gate. Scans the affected screens (and docs pages when `usabl.docs.json` is present) and returns one of four verdicts with its exit code when something was checked, or no verdict (exit 0 when idle, exit 4 when it could not decide). This is the default command.                                                                                                                                                                                                                                                                                    |
| `usabl init`                          | Drafts coverage and policy from the application tree. Runs no gate and writes no evidence.                                                                                                                                                                                                                                                                                                                                                          |
| `usabl baseline`                      | Runs a full scan and drafts the accepted accessibility floor as a reviewable working-tree diff.                                                                                                                                                                                                                                                                                                                                                     |
| `usabl install <target>`              | Wires one integration surface as a draft, exactly one per run. Targets: `--overlay`, `--claude`, `--claude-skill`, `--cursor`, `--ci`, `--docs-ci`, `--branch-rule`. `--claude-skill` writes the on-demand `/usabl-check` skill; `--cursor` writes the Cursor `/usabl-check` command and a UI rule whose globs are derived from `uiFileGlobs` in `usabl.config.json` (defaulting to `src/**` when config is absent); `--branch-rule` only verifies. |
| `usabl doctor`                        | Read-only self-check. Reports each surface as wired, missing, drifted, or unknown, including whether an authenticated session is configured, and mints no verdict.                                                                                                                                                                                                                                                                                  |
| `usabl floor prune`                   | Re-arms the floor after a full scan: removes identities that are gone and lowers the recorded count where fewer barriers remain, so a reintroduced barrier gates as new instead of staying carried.                                                                                                                                                                                                                                                 |
| `usabl drift routes`                  | Reports drift between the route manifest and the application router. Read-only.                                                                                                                                                                                                                                                                                                                                                                     |
| `usabl comment`                       | Projects a run read from stdin into a pull request comment.                                                                                                                                                                                                                                                                                                                                                                                         |
| `usabl stop-hook`                     | The stable Stop hook entry point. Runs the gate when the assistant tries to finish. It blocks the first stop attempt on a blocking verdict (regression, not covered, or approval required) unless a one-use `usabl bypass` was issued; it allows an active continuation, idle runs, and runs with no verdict, and says so. Always exits 0, so a wedged hook fails open with disclosure.                                                                                                                                                                                                                                                  |
| `usabl enforce accessibility\|policy` | Reads a gate result from stdin and returns the CI check status. Never re-runs the gate.                                                                                                                                                                                                                                                                                                                                                             |
| `usabl docs`                          | Projects design-intake and transcript artifacts as JSON on stdout. Add `--html` for one self-contained, accessible HTML page. Always exits 0 and mints no verdict.                                                                                                                                                                                                                                                                                  |
| `usabl bypass`                        | A one-time, next-stop-only escape hatch that does not verify. It lets the next Stop hook skip verification once.                                                                                                                                                                                                                                                                                                                                    |

The [team demo runbook](https://github.com/usabl-dev/usabl-app/blob/main/README.md) shows these commands in the order a team runs them. Full contracts and semantics are in [docs/ground-truth.md](docs/ground-truth.md).

## Documentation

- [Team orientation](https://usabl-dev.github.io/usabl/team-orientation.html): start here.
- [How usabl works](https://usabl-dev.github.io/usabl/how-usabl-works.html): the result model, trust boundary, and product surfaces.
- [Code walkthrough](https://usabl-dev.github.io/usabl/code-walkthrough.html): the source in the order it runs, grouped into eight systems an engineer can own.
- [Team demo runbook](https://github.com/usabl-dev/usabl-app/blob/main/README.md): the complete operational walkthrough.
- [Ground truth](docs/ground-truth.md): architecture, contracts, scan layers, adoption model, WCAG coverage, and the demo strategy.

## Status and roadmap

Team preview (v0.2.1). Teammates can learn the product, run the loop, choose a contribution lane, and file feedback. See [CHANGELOG.md](CHANGELOG.md) for changes since 0.1.0. This preview does not tag or publish the package.

The screen-reader **voicing** preview and the **fleet-insights** measurement view are built and exported, but neither is part of the gate today. Voicing is planned to enter the check path in v0.3.0. Fleet-insights aggregates committed findings for reporting only and never changes a verdict.

## Contributing

The provider interface is the contribution seam: add a check, return `Draft[]`, and ship a rule. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, including Node 22, pre-commit, and the build.

Work runs in three independent lanes, implement, review, and security review, and the lane that writes a change does not review it or grade its own work. Follow [Conventional Commits](CONTRIBUTING.md#commits), write the failing test first, and open pull requests against `main`.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

---

**Don't ship until it's usabl.**
