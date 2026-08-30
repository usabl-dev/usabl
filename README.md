# usabl

![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-team%20preview-green?style=flat-square)

**usable by default.**

usabl is an accessibility proof engine for product development workflows. It verifies that a change introduces no new machine-checkable accessibility barriers on the surfaces it touched before work can be called done, and gives one of four clear answers: verified, regression, not covered, or approval required. Accessibility, aligned with WCAG 2.2 AA, is the scope; screen-reader announcement is the differentiating layer, not the whole claim.

The AI can suggest fixes. It does not get to grade its own work.

## What it does

- Runs the same trustworthy check across the AI stop hook, dev-server overlay, CI gate, and Playwright helper
- Combines general accessibility scanning, PatternFly rule checks, and keyboard/screen-reader announcement tests
- Produces re-verifiable evidence tied to the exact code state

## Status

Team preview (v0.2.0). Teammates can learn the product, run the loop, choose a
contribution lane, and file feedback. See [CHANGELOG.md](CHANGELOG.md) for
merged changes since 0.1.0. This freeze does not tag or publish the package.

Start with the
[team orientation](https://usabl-dev.github.io/usabl/team-orientation.html) and
[How usabl works](https://usabl-dev.github.io/usabl/how-usabl-works.html). The
[team demo runbook](https://github.com/usabl-dev/usabl-app/blob/main/README.md) is the complete operational walkthrough.

## Quick start

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
npm install
npm run build
```

Node 22 required. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup (pre-commit, hooks, CI).

## Command surface

These commands draft, inspect, wire, and report, but only the gate decides a verdict. Locally the gate is `usabl check`; in CI, `usabl enforce` turns the gate's result into the required check status. Nothing else on this list mints a verdict.

The gate:

- `usabl check` runs the accessibility gate on the affected screens and returns one verdict with its exit code. It is the default command.

Adoption and setup:

- `usabl init` drafts coverage and policy from the application tree. It does not run the gate and writes no waivers or evidence.
- `usabl baseline` runs a full scan and drafts the accepted accessibility floor in `.usabl-evidence.json` as a reviewable working-tree diff.
- `usabl install --overlay|--claude|--ci|--branch-rule` wires exactly one surface as a draft and enables nothing on its own. `--branch-rule` is a read-only verify.
- `usabl doctor` is a read-only self-check. It reports each surface as wired, missing, drifted, or unknown, and mints no verdict.

Maintenance:

- `usabl floor prune` re-arms the floor after a full scan by removing paid-down identities from `.usabl-evidence.json`, so a reintroduced barrier gates as new instead of staying carried.
- `usabl drift routes` reports drift between the route manifest and the application router. It reads only and mints no verdict.

CI and hook surfaces:

- `usabl comment` projects a run read from stdin into a pull request comment. It does not run the gate.
- `usabl stop-hook` is the stable Stop hook entry point. It runs the gate when the assistant tries to finish and blocks continuation through the Stop hook decision when the gate reports a new barrier, an uncovered change, or a policy change that needs approval, or when a guarded policy file changes during the session. It always exits 0, so a wedged hook fails open with disclosure instead of blocking through an exit code.
- `usabl enforce accessibility|policy` reads a gate result from stdin and returns the CI check status. It never re-runs the gate.

Reporting:

- `usabl docs` projects design-intake and transcript artifacts from a full run as JSON on stdout. It is a generator, not a gate: it always exits 0 and mints no verdict.

The bypass escape hatch:

- `usabl bypass` is a one-time, next-stop-only escape hatch that does not verify. It sets a marker so the next Stop hook skips verification once.

## Design

See [docs/ground-truth.md](docs/ground-truth.md) for the complete project ground truth:
architecture, contracts, scan layers, surfaces, adoption model, design intake, docs
output, WCAG coverage map, demo strategy, and team plan.

## Commits

Follow [Conventional Commits](CONTRIBUTING.md#commits).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

## Slogan

Don't ship until it's usabl.
