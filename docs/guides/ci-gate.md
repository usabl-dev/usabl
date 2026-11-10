# Set up the CI gate

`usabl install --ci` writes two GitHub Actions workflows into your app:

- `.github/workflows/usabl-gate.yml`, the pull request gate. Its `usabl-required` job is
  the check to require on your protected branch.
- `.github/workflows/usabl-history.yml`, which scans main after each merge and once a day
  and records what it saw on a `usabl/history` branch.

Run it from your app's root, after `usabl init` has written `usabl.config.json`:

```bash
npx usabl install --ci
```

It writes a file only when it is absent. It never overwrites a workflow you edited; it says
where the file differs and stops with exit 2.

## What it fills in for you

**The engine pin.** Each workflow builds the usabl engine from the public
`usabl-dev/usabl` repository at one commit. The build of usabl records the commit it was
built from in `dist/build-info.json`, and `install --ci` writes that commit into the
`usabl-engine` job. It uses only a full 40-character commit SHA from a clean tree, never a
branch or a tag.

When the record has no such commit, the pin stays the placeholder
`PIN_TO_A_TRUSTED_USABL_COMMIT`. That happens when usabl was built outside git, or from a
tree with uncommitted or untracked changes. The command says which, and names the line to
edit in each file. Until the line holds a commit, the engine checkout fails and the gate
blocks. The same is true of a commit that is not on `usabl-dev/usabl`: the gate fails
closed, never open.

`install --ci` never moves a pin someone already chose. If the workflow is the usabl draft
pinned to another commit, it reports that commit and changes nothing. If the workflow is
the earlier usabl draft with the placeholder, and this build has a commit, it fills the pin
in.

**No secrets.** The engine repository is public, so no job needs a token to fetch it. The
only token any job reads is the run's own `GITHUB_TOKEN`. A pull request from a fork runs
the gate the same way. A fork cannot write to its pull request, so its usabl comment
appears in the run summary instead.

**The app's port.** Neither workflow assumes a port. The judge serves the built app on the
origin of `appBaseUrl` in `usabl.config.json` at the base commit. The history scan reads
`appBaseUrl` from main and starts `npm run dev -- --host <host> --port <port>` on it.
`appBaseUrl` must be an http address on loopback (`127.0.0.1`, `localhost`, or `[::1]`)
with an explicit port, or the job stops with a message that says what is wrong.

`install --ci` reads the same value to tell you what it found. Before `usabl init` has run,
it reads the port from your app instead: a `--port` in the `dev` script, then
`server.port` in the Vite config, then `devServer.port` in the webpack dev config. On
patternfly-react-seed it reads 9000 from `webpack.dev.js`. It does not run any of these
files, so a port set by code is not read; the step it prints then lists every place it
looked.

## The steps it prints

The command ends with a numbered list of the steps still needed. When the pin is filled,
`appBaseUrl` can be read, and `package.json` has a `dev` script, the list is:

1. Merge `usabl.config.json` (and `usabl.routes.json` when you use it) to your default
   branch first, in their own pull request. The judge reads them at the base commit of each
   pull request, so a pull request that adds them together with the workflows cannot pass.
2. Review and commit the two workflow files.
3. Add the branch rule. `usabl install --branch-rule` prints the `CODEOWNERS` lines and
   the branch setting, then checks them when you run it again.
4. Open a pull request.

The command leaves out step 1 only when git shows that your default branch already holds
the same bytes of those files as your working tree. When it cannot find the default branch,
or git cannot answer, it prints the step.

Each other thing the run could not settle adds one step in front: pin the engine, run
`usabl init` and set `appBaseUrl`, or add a `dev` script for the history scan.

The branch rule matters. Any pull request runs the workflow as that pull request changed
it, so a pull request that edits `.github/workflows/` can make `usabl-required` pass. Code
owner review on `.github/workflows/` is what stops it.

## Settings you may need

- `USABL_APP_BUILD_COMMAND` and `USABL_APP_BUILD_DIR`, repository variables, when your app
  does not build with `npm run build` into `dist`.
- The history workflow's `history-append` job needs `contents: write`. If you cannot grant
  it, leave `usabl-history.yml` out; every run then says tracking is off.

## What has been proven

The pin fill, the port read, and the printed steps are covered by unit tests. The package
smoke test installs the packed usabl and runs `install --ci` from it, and checks that the
written pin matches the build record. The workflows as this version writes them have not
yet run on a GitHub runner with no hand edits.
