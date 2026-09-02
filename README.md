# usabl

![Version](https://img.shields.io/badge/version-0.2.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-team%20preview-orange?style=flat-square)

**usable by default.**

usabl is an accessibility proof engine for product development. It checks that a change adds no new machine-checkable accessibility barriers on the surfaces it touched, and it will not let the work be called done until that is true. Every run returns one of four clear answers: verified, regression, not covered, or approval required. The scope is accessibility aligned with WCAG 2.2 AA. Screen-reader announcement is the differentiating layer, not the whole claim.

> **The AI can suggest fixes. It does not get to grade its own work.**

## Why usabl

Most accessibility tools find issues. Very few prove the fix actually worked, and almost none stop an AI assistant from marking inaccessible work complete. usabl closes that loop:

- **Proof, not a report.** A change is done only when the gate verifies it. The result is a receipt you can re-check later, not a slide of green numbers.
- **The same check everywhere.** One deterministic engine runs in the assistant, the browser, and the pull request, so the answer never depends on where you look.
- **Honest by construction.** The engine keeps verified, not covered, and merely observed apart in words, never by color. It never claims compliance, and it says so on its own output.
- **Debt that only shrinks.** Known issues sit in a reviewed floor with owners and expiry dates. New barriers block. The floor ratchets down and never grows silently.

## The four verdicts

Every `usabl check` ends in exactly one verdict, each with a matching exit code:

| Verdict               | Meaning                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Verified**          | No new gating barriers on the touched surfaces, and coverage was complete. A receipt is minted.          |
| **Regression**        | A new machine-checkable barrier appeared. The change is blocked.                                         |
| **Not covered**       | usabl could not check a touched surface, so it refuses to guess. This is honest uncertainty, not a pass. |
| **Approval required** | The change edits policy itself, which needs a human code-owner decision before it can land.              |

Only the gate mints a verdict. Every other command drafts, inspects, wires, or reports.

## How it works

- **Deterministic checks.** Three layers run on every scan: general accessibility rules through axe-core, PatternFly composition rules, and a keyboard and announcement walk. No layer asks a model to judge pass or fail.
- **One gate, four surfaces.** The same check runs as a Claude Stop hook, a dev-server overlay, a CI gate, and a Playwright helper. The library ships those integrations as subpath exports (`usabl/vite`, `usabl/playwright`, `usabl/docs`).
- **Receipts bound to the code.** A verified result mints a receipt tied to the exact source tree, the committed policy, the runner version, and the scanner versions. Change any of them and it no longer verifies.
- **AI proposes, the gate decides.** The assistant can suggest and apply fixes, then it must re-run the same gate. It cannot approve its own work.

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

usabl reads the variable once, where it builds its dependencies, so every surface picks up the same session: the CLI, the Vite overlay, and the Claude Stop hook. It is an environment variable rather than a flag because the overlay and the Stop hook have no command line, and rather than a config field because the file holds live cookies and tokens. A path to a storage state never enters committed config, and the file itself never enters the repository.

If the variable names a file usabl cannot read, or a file that is not JSON, the run stops with an error instead of quietly scanning signed out. usabl prints neither the path nor the contents, in errors or in reports. It also cannot tell whether a session is still accepted by your application: an expired session scans signed out.

## Command surface

These commands draft, inspect, wire, and report. Only `usabl check` decides a verdict.

| Command                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usabl check`                         | The gate. Scans the affected screens and returns one verdict with its exit code. This is the default command.                                                                                                                                                                                                                                                                                                                                       |
| `usabl init`                          | Drafts coverage and policy from the application tree. Runs no gate and writes no evidence.                                                                                                                                                                                                                                                                                                                                                          |
| `usabl baseline`                      | Runs a full scan and drafts the accepted accessibility floor as a reviewable working-tree diff.                                                                                                                                                                                                                                                                                                                                                     |
| `usabl install <target>`              | Wires one integration surface as a draft, exactly one per run. Targets: `--overlay`, `--claude`, `--claude-skill`, `--cursor`, `--ci`, `--docs-ci`, `--branch-rule`. `--claude-skill` writes the on-demand `/usabl-check` skill; `--cursor` writes the Cursor `/usabl-check` command and a UI rule whose globs are derived from `uiFileGlobs` in `usabl.config.json` (defaulting to `src/**` when config is absent); `--branch-rule` only verifies. |
| `usabl doctor`                        | Read-only self-check. Reports each surface as wired, missing, drifted, or unknown, including whether an authenticated session is configured, and mints no verdict.                                                                                                                                                                                                                                                                                  |
| `usabl floor prune`                   | Re-arms the floor after a full scan so a reintroduced barrier gates as new instead of staying carried.                                                                                                                                                                                                                                                                                                                                              |
| `usabl drift routes`                  | Reports drift between the route manifest and the application router. Read-only.                                                                                                                                                                                                                                                                                                                                                                     |
| `usabl comment`                       | Projects a run read from stdin into a pull request comment.                                                                                                                                                                                                                                                                                                                                                                                         |
| `usabl stop-hook`                     | The stable Stop hook entry point. Runs the gate when the assistant tries to finish and blocks continuation through the hook decision. Always exits 0, so a wedged hook fails open with disclosure.                                                                                                                                                                                                                                                  |
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
