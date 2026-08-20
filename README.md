# usabl

![Status](https://img.shields.io/badge/status-early%20development-orange?style=flat-square)
![Version](https://img.shields.io/badge/version-0.0.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)

**usable by default.**

usabl is an accessibility proof engine for product development workflows. It verifies that a change introduces no new machine-checkable accessibility barriers on the surfaces it touched before work can be called done, and gives one of four clear answers: verified, regression, not covered, or approval required. Accessibility, aligned with WCAG 2.2 AA, is the scope; screen-reader announcement is the differentiating layer, not the whole claim.

The AI can suggest fixes. It does not get to grade its own work.

## What it does

- Runs the same trustworthy check across the AI stop hook, dev-server overlay, CI gate, and Playwright helper
- Combines general accessibility scanning, PatternFly rule checks, and keyboard/screen-reader announcement tests
- Produces re-verifiable evidence tied to the exact code state

## Status

Early development for Innovation Days 2026.

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
