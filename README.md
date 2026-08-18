# Usabl

![Status](https://img.shields.io/badge/status-early%20development-orange?style=flat-square)
![Version](https://img.shields.io/badge/version-0.0.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)

**Usable by default.**

Usabl is a proof engine for accessibility in product development workflows. It checks whether a screen is truly usable by a screen reader before work can be called done, and gives one of four clear answers: verified, regression, not covered, or approval required.

The AI can suggest fixes. It does not get to grade its own work.

## What it does

- Runs the same trustworthy check across the AI stop hook, dev-server overlay, CI gate, and Playwright helper
- Combines general accessibility scanning, PatternFly rule checks, and keyboard/screen-reader announcement tests
- Produces re-verifiable evidence tied to the exact code state

## Status

Early development for Innovation Days 2026.

## Commits

Follow [Conventional Commits](CONTRIBUTING.md#commits).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

## Slogan

Don't ship until it's Usabl.
