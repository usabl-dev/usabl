# usabl

![Version](https://img.shields.io/badge/version-0.2.2-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![CI](https://github.com/usabl-dev/usabl/actions/workflows/usabl.yml/badge.svg?branch=main)](https://github.com/usabl-dev/usabl/actions/workflows/usabl.yml)

usabl is an accessibility proof engine for web apps. It checks the screens a code
change touches, while the code is being written, and tells you whether that change
added an accessibility barrier.

It proves one narrow thing: on the screens it checked, the change added no new
barrier that a machine can detect, compared with the barriers your team has already
recorded. When usabl cannot check something, it says so instead of reporting a
pass.

[Read the walkthrough](https://usabl-dev.github.io/usabl/) for the whole product in one
page.

## How it works

- **Repeatable checks only.** Results come from axe-core, a PatternFly rulepack, and a
  keyboard walk in a real Chromium browser. usabl calls no AI model. An AI assistant can
  fix a barrier, but it cannot decide the result.
- **One verdict.** A run that checked something returns `verified`, `regression`,
  `approval_required`, or `not_covered`. A run that had nothing to check, or that could
  not finish, returns no verdict. No verdict is not a pass.
- **Existing debt does not block.** usabl records the barriers already in your app as an
  evidence floor. Only new barriers block, so you can adopt it without fixing everything
  first.
- **One engine, many places.** The same engine runs in the command line, a browser
  overlay, an AI assistant's Stop hook, a pull request check, and your Playwright tests.
  It can also check your product documentation.
- **A pull request cannot grade itself.** In CI, policy is read from the trusted base
  branch, so a change cannot weaken the rules it is checked against.

## Install

usabl needs Node.js 22 or later. It is not on npm yet, so build the latest release
from source in a folder next to your app:

```bash
git clone --branch v0.2.2 https://github.com/usabl-dev/usabl.git
cd usabl
npm ci
npm run build
npx playwright install chromium
```

On Linux, if Playwright reports missing system libraries, run
`npx playwright install --with-deps chromium` instead.

The `main` branch is where the next version is developed. It can be unstable, so use
a release tag.

Then add it to your app:

```bash
cd ../your-app
npm install --save-dev file:../usabl
```

## Quick start

Start your app's dev server, then draft your configuration, record the barriers that
are already there, and check a change:

```bash
npx usabl init       # drafts usabl.config.json and usabl.routes.json from your code
npx usabl baseline   # scans every mapped screen and drafts .usabl-evidence.json
npx usabl check
```

Review and commit each drafted file before you run the next step, because usabl does
not trust policy files with uncommitted changes.

Then set up the other places usabl runs, one per command:

```bash
npx usabl install --overlay       # browser overlay in the Vite dev server
npx usabl install --claude        # Claude Code Stop hook
npx usabl install --claude-skill  # /usabl-check and /usabl-fix skills
npx usabl install --cursor        # Cursor stop hook, command, and rule
npx usabl install --ci            # pull request gate for GitHub Actions
npx usabl doctor                  # reports what is set up and what is missing
```

To try usabl on an app with known barriers first, use the
[usabl-app](https://github.com/usabl-dev/usabl-app) sample.

## What usabl does not do

- It does not claim an app is accessible or compliant. Its checks follow WCAG 2.2 AA,
  and many criteria need a person to judge.
- It does not replace expert audits or testing with people who use assistive
  technology.
- It does not judge quality. It can prove an image has alternative text. It cannot
  prove the text is useful.
- The virtual screen reader check is built and tested, but it is not part of the result
  yet.

## Status

Version 0.2.2. This is an early release, and it is not on npm yet.

What has been proven, and on what:

- Unit tests for the engine, the gate, and every surface, and integration tests in a
  real Chromium, run in CI on every pull request.
- The full loop (break, block, repair, verify) has been run on the
  [usabl-app](https://github.com/usabl-dev/usabl-app) sample, a PatternFly 6 app with
  known barriers.
- usabl mechanically checks 21 of the 55 WCAG 2.2 Level A and AA criteria.

Known limits:

- Route discovery and the development overlay are built for React and Vite today.
- usabl has not been load tested against a large fleet of applications.
- Screens behind a login need a stored session, set with `USABL_STORAGE_STATE`. usabl
  detects many sign-in pages and reports them as gaps, but not every kind.
- The CI workflow that `usabl install --ci` writes builds the engine from a commit of
  this repository that you pin.

## Documentation

- [Walkthrough](https://usabl-dev.github.io/usabl/): the whole product in one page.
- [How usabl works](https://usabl-dev.github.io/usabl/how-usabl-works.html): result
  rules, the trust model, and the surfaces.
- [Code walkthrough](https://usabl-dev.github.io/usabl/code-walkthrough.html): the
  source, system by system.
- [Guides](https://github.com/usabl-dev/usabl/tree/main/docs/guides): run the proof
  loop, test and report, and how the project is developed.
- [Changelog](CHANGELOG.md)

## Contributing

usabl is not accepting pull requests yet. Bug reports and feedback are welcome through
the [issue forms](https://github.com/usabl-dev/usabl/issues/new/choose).

- [CONTRIBUTING.md](CONTRIBUTING.md): what the project accepts today.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how people in this project treat each other.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
