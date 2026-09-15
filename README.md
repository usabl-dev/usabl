# usabl

![Version](https://img.shields.io/badge/version-0.2.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-team%20preview-orange?style=flat-square)

**Don't ship until it's usabl.**

[How usabl works: a walkthrough of the whole product](https://usabl-dev.github.io/usabl/)

usabl checks changes to a web app's user interface for accessibility problems while the code is being written. It can also check your product documentation, because an app is not truly usable if its documentation is not. It runs from the command line, a browser overlay, an AI coding assistant, a pull request check, and your Playwright tests, and all of them use the same engine.

Every result comes from repeatable checks. usabl calls no AI model. An AI assistant can suggest and apply fixes, but it cannot decide the result.

A run that checked something returns verified, regression, approval required, or not covered. A run can also return no result at all, either because nothing usabl checks changed or because it could not finish. No result is not a pass. Problems that were already in the app are recorded and do not block, so you can add usabl to an app without fixing everything first.

## Try it

usabl needs Node.js 22. It is not on npm yet, so build it next to your app:

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
npm ci
npm run build
npx playwright install chromium
```

Then add it to your app, draft your configuration, record the problems that are already there, and check a change:

```bash
cd ../your-app
npm install --save-dev file:../usabl
npx usabl init       # drafts usabl.config.json and usabl.routes.json from your code
npx usabl baseline   # scans every mapped screen and drafts .usabl-evidence.json
npx usabl check
```

Review and commit each drafted file before you run the next step, because usabl does not trust policy files with uncommitted changes. `npx usabl install --claude`, `--cursor`, `--overlay`, and `--ci` set up the other places usabl runs, one per command. `npx usabl doctor` reports what is set up and what is missing.

## What usabl does not do

- It does not claim an app is accessible or compliant. Its checks follow WCAG 2.2 AA, and some problems need a person to judge.
- It does not replace expert audits or testing with people who use assistive technology.
- The virtual screen reader check is built and tested, but it is not part of the result yet.

## Status

Team preview, version 0.2.1, built for Red Hat Innovation Days 2026. This version is not tagged or published to npm.

## License

Apache License 2.0. See the LICENSE file.
