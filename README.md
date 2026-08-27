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
