/**
 * CI gate install generator for `usabl install --ci` and `usabl install --docs-ci`.
 * It emits a six-job gate that keeps pull request code away from the verdict. build-app is the
 * only job that runs head code, and it holds no secret. usabl-scan is the trusted judge: it never
 * runs head code in Node or a shell, serves the build to a sandboxed, request-filtered Chromium,
 * and publishes the accessibility verdict as a job output. usabl-engine builds the pinned engine
 * once from the public repository at a pinned commit, and every other job checks it against a
 * digest output. usabl-required is the aggregate an
 * operator makes their required status check, and it is red unless every job has the right shape
 * for the event and the judge's verdict passes. The engine SHA is a security pin. The draft
 * constants carry a documented sentinel, and the installer replaces it with the commit this usabl
 * was built from, read from the build record, only when that is a full commit SHA from a clean tree.
 * Otherwise the sentinel stays, the engine checkout fails on it, and the gate blocks.
 * Workflows are security-critical, so this writes only when absent, no-ops when identical, fills
 * the pin only in its own unedited draft, never moves a pin someone chose, and refuses when a
 * hand-tuned workflow differs rather than overwrite it.
 */
import type { InstallFs, InstallResult } from './index.js';
import { NO_BUILD_RECORD, type EnginePin } from './build-info.js';
import { appOriginReport, readAppOrigin, type AppOrigin } from './app-origin.js';
import {
  ARTIFACT_MAX_BYTES,
  ENGINE_CHECK,
  engineTreeDigestCommand,
  fetchArtifactStep,
  writeFetcherStep,
} from './artifact-fetch.js';
import { FIND_BUILD_RUN_SCRIPT, gateRunName } from './build-run.js';

export const USABL_GATE_WORKFLOW_PATH = '.github/workflows/usabl-gate.yml';

// The name of the required status check. Every consuming repository names this string in its
// branch protection or ruleset, so renaming it forces all of them to edit a setting by hand.
// Treat it as a published interface: stable, and changed only with a migration note.
export const REQUIRED_GATE_JOB = 'usabl-required';

// The one merge decision the generated gates ship, and the only place it exists. Both generated
// gate workflows embed these exact bytes, and the tests execute them, so the rule that is tested
// is the rule that runs.
//
// The rule, and why it reads the way it does.
//
// The gate is six jobs. usabl-engine builds the pinned engine. build-app runs pull request code
// to build the app, so it is untrusted and fenced to the pull_request event. usabl-scan is the
// trusted judge: it runs on both events, never runs head code in Node or a shell, and publishes
// the accessibility verdict as a job output. gate-comment posts the comment on pull_request.
// usabl-policy decides guarded-file approval on both events.
//
// Every job result here is an event-shape check. On pull_request all five jobs must have
// succeeded. On pull_request_review the build and the comment must have been skipped by their
// fence, and the engine, the judge, and the policy job must have succeeded, because the judge
// re-judges the same head on a review. Accepting anything short of the exact shape would pass on
// a cancelled job or on a judge that never ran. The accessibility verdict itself is data: the
// judge's own `verdict` output, computed by `usabl enforce accessibility` over the Result it just
// produced. A job output can be set only by that job's own steps, so pull request code that can
// tamper with artifacts in the run still cannot change it. A verdict that is missing, empty, or
// anything other than the exact string "pass" blocks.
export const REQUIRED_GATE_SCRIPT = `const event = process.env.EVENT_NAME || '';
const results = {
  'usabl-engine': process.env.ENGINE_RESULT || '',
  'build-app': process.env.BUILD_RESULT || '',
  'usabl-scan': process.env.SCAN_RESULT || '',
  'gate-comment': process.env.COMMENT_RESULT || '',
  'usabl-policy': process.env.POLICY_RESULT || '',
};
const accessibility = process.env.ACCESSIBILITY_VERDICT || '';
const blockers = [];

// The exact shape each event must produce. build-app runs pull request code, so it is fenced to
// pull_request, and gate-comment only comments on pull_request. On a review both must have been
// skipped by that fence; the judge re-judges the same head without running its code.
const shapes = {
  pull_request: {
    'usabl-engine': 'success',
    'build-app': 'success',
    'usabl-scan': 'success',
    'gate-comment': 'success',
    'usabl-policy': 'success',
  },
  pull_request_review: {
    'usabl-engine': 'success',
    'build-app': 'skipped',
    'usabl-scan': 'success',
    'gate-comment': 'skipped',
    'usabl-policy': 'success',
  },
};

const shape = Object.prototype.hasOwnProperty.call(shapes, event) ? shapes[event] : null;
if (shape === null) {
  blockers.push('unexpected event ' + (event || 'none') + '; this gate reasons about pull_request and pull_request_review only');
} else {
  for (const job of Object.keys(shape)) {
    if (results[job] !== shape[job]) {
      blockers.push('the ' + job + ' job was ' + (results[job] || 'none') + ' on this ' + event + ' event, and it must be ' + shape[job]);
    }
  }
}

// The accessibility verdict is the judge's job output, never inferred from a job status and never
// read from an artifact. Only the exact string "pass" passes, so a missing, empty, or unreadable
// verdict blocks.
if (accessibility !== 'pass') {
  blockers.push('the accessibility verdict from the judge is not a pass (verdict: ' + (accessibility || 'none') + ')');
}

if (blockers.length > 0) {
  console.error('usabl required gate: NOT verified');
  for (const blocker of blockers) {
    console.error('  - ' + blocker);
  }
  process.exit(1);
}
console.log('usabl required gate: verified. Accessibility and policy both pass for this head.');`;

// The rule the engine's own checked-in gate still runs. That workflow keeps the earlier three-job
// shape, because the engine repository has no app to build: its config targets a fixture
// directory that does not exist, so there is nothing for a judge to serve. These bytes are kept
// here so the tests can hold that workflow to the exact rule it embeds.
export const ENGINE_SELF_GATE_SCRIPT = `const event = process.env.EVENT_NAME || '';
const scan = process.env.SCAN_RESULT || '';
const policy = process.env.POLICY_RESULT || '';
const accessibility = process.env.ACCESSIBILITY_VERDICT || '';
const blockers = [];

// The scan job runs PR head code, so it is fenced to the pull_request event and cannot run
// on a review. Its result is an event-shape check here, never a verdict. Requiring success
// on a review event would break every approval re-run; accepting "not failure" would pass
// on cancelled and on a scan that never ran. Both are wrong, so neither is written here.
if (event === 'pull_request') {
  if (scan !== 'success') {
    blockers.push('the accessibility scan job did not succeed on this pull_request event (result: ' + (scan || 'none') + ')');
  }
} else if (event === 'pull_request_review') {
  if (scan !== 'skipped') {
    blockers.push('the accessibility scan job was not skipped on this pull_request_review event (result: ' + (scan || 'none') + '), so the head-code fence did not hold');
  }
} else {
  blockers.push('unexpected event ' + (event || 'none') + '; this gate reasons about pull_request and pull_request_review only');
}

// usabl-policy resolves the Result artifact for this head on both events, so it is the job
// that carries both verdicts out. Its outputs mean something only if it finished cleanly:
// failure, cancelled, and skipped all block.
if (policy !== 'success') {
  blockers.push('the policy job did not succeed (result: ' + (policy || 'none') + ')');
}

// The accessibility verdict is data read from the Result artifact, never inferred from a job
// status. On a review re-run it is the only accessibility authority that exists, because the
// scan job is skipped. Only the exact string "pass" passes, so a missing, empty, or
// unreadable verdict blocks.
if (accessibility !== 'pass') {
  blockers.push('the accessibility verdict from the Result artifact is not a pass (verdict: ' + (accessibility || 'none') + ')');
}

if (blockers.length > 0) {
  console.error('usabl required gate: NOT verified');
  for (const blocker of blockers) {
    console.error('  - ' + blocker);
  }
  process.exit(1);
}
console.log('usabl required gate: verified. Accessibility and policy both pass for this head.');`;

// Indent a script for embedding in a YAML block scalar. Blank lines stay blank so the
// trailing-whitespace hook has nothing to strip and the embedded bytes stay stable.
export function indentScript(script: string, indent: string): string {
  return script
    .split('\n')
    .map((line) => (line === '' ? '' : `${indent}${line}`))
    .join('\n');
}

// The embedded form used by every gate workflow: ten spaces, the depth of a step `run:` body.
const EMBEDDED_GATE_SCRIPT = indentScript(REQUIRED_GATE_SCRIPT, '          ');

// The gate checks the engine out from the public usabl-dev/usabl repository at a commit the
// operator trusts, so the engine that judges a pull request is code the operator chose, never the
// pull request's. The draft constants carry a documented sentinel. The installer replaces it with
// the commit this usabl was built from, when its build record names one from a clean tree. It never
// invents a SHA, and it never reads the network for one: the sentinel stays, and the engine
// checkout fails on it, so the gate blocks until the operator pins a commit.
export const ENGINE_REF_PLACEHOLDER = 'PIN_TO_A_TRUSTED_USABL_COMMIT';

// The one engine ref line every draft carries, at the depth of a step's `with:` block.
const ENGINE_REF_LINE = `          ref: ${ENGINE_REF_PLACEHOLDER}`;

/**
 * The draft with its engine ref pinned to `sha`. Only a full 40-character lowercase commit SHA is
 * accepted, so a branch or a tag, which can move, is never written as the pin. The draft must hold
 * exactly one placeholder ref line, so a pinned or reshaped draft is never pinned again.
 */
export function pinEngineRef(draft: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('the engine pin must be a full 40-character lowercase commit SHA');
  }
  const lines = draft.split('\n');
  const at = lines.flatMap((line, index) => (line === ENGINE_REF_LINE ? [index] : []));
  if (at.length !== 1 || countDraftEngineRefLines(draft) !== 1) {
    throw new Error('the draft must hold exactly one placeholder engine ref line');
  }
  lines[at[0] ?? 0] = `          ref: ${sha}`;
  return lines.join('\n');
}

/** The one-based line of the engine ref in a placeholder draft, for the report that names it. */
export function engineRefLineNumber(draft: string): number {
  return draft.split('\n').indexOf(ENGINE_REF_LINE) + 1;
}

// Check one downloaded artifact before anything reads it. The expected digest is a job output,
// which only the producing job's own steps can set, passed in through env and format-checked
// before use. The download directory must hold exactly the one expected regular file, so an
// artifact that was replaced or padded by code elsewhere in the run is refused, not searched.
export function verifyDownload(dirVar: string, file: string, digestVar: string, what: string): string {
  return `          if ! [[ "\${${digestVar}}" =~ ^[0-9a-f]{64}$ ]]; then
            echo "the expected ${what} digest is not a sha256 hex string; failing closed"
            exit 1
          fi
          if [ "$(ls -A "\${${dirVar}}")" != "${file}" ] || [ -L "\${${dirVar}}/${file}" ] || [ ! -f "\${${dirVar}}/${file}" ]; then
            echo "the ${what} artifact is not exactly one regular file named ${file}; failing closed"
            exit 1
          fi
          printf '%s  %s\\n' "\${${digestVar}}" "\${${dirVar}}/${file}" | sha256sum -c -`;
}

// Download and unpack the trusted engine in a job that must not take it on faith. In trusted jobs
// the engine lives under the runner temp directory, outside every checkout, so a bare module
// import from the engine can never resolve to a node_modules directory a pull request committed.
export const UNPACK_ENGINE_IN_TEMP = `          mkdir "\${RUNNER_TEMP}/usabl-engine"
          tar --extract --gzip --no-same-owner --file "\${DOWNLOAD_DIR}/usabl-engine.tgz" --directory "\${RUNNER_TEMP}/usabl-engine"`;

// The engine in a trusted job: write usabl's own artifact fetcher, take the engine archive through
// it, check the archive against the engine job's digest output, and unpack it. Each step that runs
// the engine afterwards checks the unpacked tree again, with ENGINE_CHECK, right before it runs.
export function trustedEngineSteps(stepName: string, unpack: string): string {
  return `${writeFetcherStep()}

${fetchArtifactStep({
  stepName,
  artifact: 'usabl-engine',
  member: 'usabl-engine.tgz',
  into: 'usabl-download-engine',
  maxBytes: ARTIFACT_MAX_BYTES.engine,
  env: `          ENGINE_DIGEST: \${{ needs.usabl-engine.outputs.engine_digest }}
          DOWNLOAD_DIR: \${{ runner.temp }}/usabl-download-engine`,
  then: `${verifyDownload('DOWNLOAD_DIR', 'usabl-engine.tgz', 'ENGINE_DIGEST', 'engine')}
${unpack}`,
})}`;
}

export const TRUSTED_ENGINE_STEP = 'Fetch, verify, and unpack the trusted engine';

function installTrustedEngineSteps(): string {
  return trustedEngineSteps(TRUSTED_ENGINE_STEP, UNPACK_ENGINE_IN_TEMP);
}

// build-app runs pull request code, so it may already hold the runner token that can replace any
// artifact; the engine it builds with gains it nothing it does not have. It keeps the plain download.
function buildEngineSteps(unpack: string): string {
  return `      - name: Download the engine
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-engine
          path: \${{ runner.temp }}/usabl-download-engine

      - name: Install the engine where the app expects it
        working-directory: \${{ runner.temp }}
        env:
          ENGINE_DIGEST: \${{ needs.usabl-engine.outputs.engine_digest }}
          DOWNLOAD_DIR: \${{ runner.temp }}/usabl-download-engine
        run: |
${verifyDownload('DOWNLOAD_DIR', 'usabl-engine.tgz', 'ENGINE_DIGEST', 'engine')}
${unpack}`;
}

// The job that builds the pinned engine and hands it on as a digest-checked archive. The gates and
// the history workflow share these exact bytes, so the engine is built and pinned one way.
export const ENGINE_JOB = `  usabl-engine:
    # The trusted engine, built from the pinned commit and handed to every other job as a
    # digest-checked archive. It runs no pull request code. The engine repository is public, so
    # this job needs no token and a pull request from a fork runs the gate like any other.
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      engine_digest: \${{ steps.pack.outputs.engine_digest }}
      engine_tree_digest: \${{ steps.pack.outputs.engine_tree_digest }}
    steps:
      - name: Checkout trusted usabl engine commit
        # A full commit SHA you trust. The pull request never chooses the engine that judges it.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: ${ENGINE_REF_PLACEHOLDER}
          path: usabl-engine
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

      - name: Install and build trusted engine
        working-directory: usabl-engine
        run: |
          # A fresh npm cache under the runner temp directory, never one a pull request could seed.
          export npm_config_cache="\${RUNNER_TEMP}/usabl-npm-cache"
          npm ci
          npm run build
          # Keep only what the engine needs at run time, so no later job runs npm for it.
          npm prune --omit=dev

      - name: Pack trusted engine
        id: pack
        working-directory: usabl-engine
        run: |
          # package.json, dist, and the production node_modules the lockfile pinned. The .git
          # directory and the sources stay out.
          tar --create --gzip --file "\${RUNNER_TEMP}/usabl-engine.tgz" --exclude=.git --exclude=node_modules/.bin package.json dist node_modules
          echo "engine_digest=$(sha256sum "\${RUNNER_TEMP}/usabl-engine.tgz" | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"
          # The digest of the tree a job gets when it unpacks this archive. Each trusted job checks
          # its unpacked engine against it right before it runs the engine.
          mkdir "\${RUNNER_TEMP}/usabl-engine-tree"
          tar --extract --gzip --no-same-owner --file "\${RUNNER_TEMP}/usabl-engine.tgz" --directory "\${RUNNER_TEMP}/usabl-engine-tree"
          echo "engine_tree_digest=$${engineTreeDigestCommand('${RUNNER_TEMP}/usabl-engine-tree')}" >> "$GITHUB_OUTPUT"

      - name: Upload trusted engine
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-engine
          path: \${{ runner.temp }}/usabl-engine.tgz
          if-no-files-found: error
          retention-days: 1
`;

// What differs between the app gate and the docs gate. Everything else, every job boundary and
// every check, is the same template, so a fix to one gate is a fix to both.
interface GateVariant {
  name: string;
  workflowFile: string;
  // build-app steps after the head checkout and Node setup, ending with the packed build.
  buildSteps: string;
  // build-app needs the engine only when the build itself imports usabl.
  buildNeedsEngine: boolean;
  // The judge step that serves the unpacked build on loopback.
  serveStep: string;
}

const APP_BUILD_STEPS = `${buildEngineSteps(
  `          # For now the lockfile pins usabl as file:../usabl, and Actions has no sibling folder.
          # Later: npm ci installs usabl from the registry. Drop this step.
          mkdir "\${GITHUB_WORKSPACE}/../usabl"
          tar --extract --gzip --no-same-owner --file "\${DOWNLOAD_DIR}/usabl-engine.tgz" --directory "\${GITHUB_WORKSPACE}/../usabl"`,
)}

      - name: Install app dependencies
        run: npm ci --ignore-scripts

      - name: Build the app
        env:
          APP_BUILD_COMMAND: \${{ vars.USABL_APP_BUILD_COMMAND }}
        run: |
          # This is pull request code. It runs here and nowhere else.
          bash -c "\${APP_BUILD_COMMAND:-npm run build}"

      - name: Pack the build
        id: pack
        env:
          APP_BUILD_DIR: \${{ vars.USABL_APP_BUILD_DIR }}
        run: |
          build_dir="\${APP_BUILD_DIR:-dist}"
          if [ ! -d "\${build_dir}" ]; then
            echo "the build produced no \${build_dir} directory; set USABL_APP_BUILD_DIR if it writes elsewhere"
            exit 1
          fi
          tar --create --exclude=./.usabl --file "\${RUNNER_TEMP}/usabl-app-build.tar" --directory "\${build_dir}" .
          echo "build_digest=$(sha256sum "\${RUNNER_TEMP}/usabl-app-build.tar" | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"`;

const DOCS_BUILD_STEPS = `      - name: Build the documentation
        env:
          DOCS_BUILD_COMMAND: \${{ vars.USABL_DOCS_BUILD_COMMAND }}
        run: |
          # This is pull request code. It runs here and nowhere else. Set the repository variable
          # USABL_DOCS_BUILD_COMMAND to your build, for example "ccutil compile". ccutil is a
          # container build, so confirm the runner can run containers.
          if [ -z "\${DOCS_BUILD_COMMAND}" ]; then
            echo "USABL_DOCS_BUILD_COMMAND repository variable is not set; failing closed."
            exit 1
          fi
          bash -c "\${DOCS_BUILD_COMMAND}"

      - name: Pack the build
        id: pack
        env:
          BUILT_ROOT: \${{ vars.USABL_DOCS_BUILT_ROOT }}
        run: |
          if [ -z "\${BUILT_ROOT}" ] || [ ! -d "\${BUILT_ROOT}" ]; then
            echo "USABL_DOCS_BUILT_ROOT is not set or is not a directory the build wrote; failing closed."
            exit 1
          fi
          tar --create --exclude=./.usabl --file "\${RUNNER_TEMP}/usabl-app-build.tar" --directory "\${BUILT_ROOT}" .
          echo "build_digest=$(sha256sum "\${RUNNER_TEMP}/usabl-app-build.tar" | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"`;

function waitForServer(): string {
  return `          echo "SERVE_PID=$!" >> "$GITHUB_ENV"
          for _ in $(seq 1 60); do
            if grep -q 'usabl: serving' "\${RUNNER_TEMP}/usabl-serve.log"; then
              exit 0
            fi
            sleep 1
          done
          echo "the build server did not start"
          cat "\${RUNNER_TEMP}/usabl-serve.log"
          exit 1`;
}

const APP_SERVE_STEP = `      - name: Serve the build on the trusted app origin
        working-directory: head
        run: |
          # The engine reads appBaseUrl from the trusted base commit, never from the head, and binds
          # only a loopback host with an explicit port. A pull request cannot move the judge to a
          # server of its own.
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" serve-build --dir "\${RUNNER_TEMP}/usabl-app" --trusted-ref "\${BASE_SHA}" > "\${RUNNER_TEMP}/usabl-serve.log" 2>&1 &
${waitForServer()}`;

const DOCS_SERVE_STEP = `      - name: Serve the built documentation on localhost
        env:
          SERVE_PORT: \${{ vars.USABL_DOCS_SERVE_PORT }}
        working-directory: \${{ runner.temp }}
        run: |
          # usabl.docs.json docsBaseUrl at the trusted ref must be
          # http://127.0.0.1:<USABL_DOCS_SERVE_PORT> (optionally with a path) so the scan targets
          # this server. The isolated browser allows only the trusted docs origin.
          case "\${SERVE_PORT}" in
            ''|*[!0-9]*)
              echo "USABL_DOCS_SERVE_PORT is not set or not numeric; failing closed."
              exit 1
              ;;
          esac
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" serve-build --dir "\${RUNNER_TEMP}/usabl-app" --host 127.0.0.1 --port "\${SERVE_PORT}" > "\${RUNNER_TEMP}/usabl-serve.log" 2>&1 &
${waitForServer()}`;

// The Result checks the judge runs before it publishes a verdict. Node builtins only, run from
// the runner temp directory, so nothing in a checkout can be resolved by it.
const VALIDATE_RESULT_SCRIPT = `          node <<'NODE'
          const fs = require('node:fs');
          const result = JSON.parse(fs.readFileSync('usabl-judge/usabl-result.json', 'utf8'));
          const capturedExit = Number(process.env.USABL_EXIT);
          if (result.schemaVersion !== 'usabl.result.v1') {
            throw new Error('usabl produced an unsupported Result schema');
          }
          if (!Number.isInteger(result.exitCode)) {
            throw new Error('usabl Result has no integer exit code');
          }
          if (!Number.isInteger(capturedExit) || result.exitCode !== capturedExit) {
            throw new Error('usabl Result exit code does not match the process exit code');
          }
          if (result.accessibilityExitCode === 2) {
            throw new Error('accessibilityExitCode cannot be 2');
          }
          if (result.judge === undefined || result.judge.isolatedBrowser !== true) {
            throw new Error('usabl Result does not record the isolated browser');
          }
          if (result.judge.buildDigest !== process.env.USABL_BUILD_DIGEST) {
            throw new Error('usabl Result does not record the build digest this job verified');
          }
          NODE`;

function gateWorkflow(variant: GateVariant): string {
  return `name: ${variant.name}
# Each run is named after the event, pull request, head, and base that started it, so a review can
# find the build of this exact pull request even when another pull request has the same head.
run-name: ${gateRunName(variant.name)}

on:
  pull_request:
    branches: [main]
    # Retargeting onto main must re-run trusted-ref policy checks.
    types: [opened, synchronize, reopened, edited]
  pull_request_review:
    # Use the event payload so a review still knows the base branch and head SHA.
    types: [submitted, edited, dismissed]

permissions:
  contents: read

# Who may run what. Only build-app runs pull request code, and it holds no secret. A job that
# runs head code on a hosted runner has sudo, so it may be able to read the runner's own token
# and upload, delete, or replace artifacts in this run. So no trusted job believes an artifact
# by its name: each one checks what it downloads against a digest from a job output, which only
# the producing job's own steps can set. No trusted job unpacks an artifact with
# actions/download-artifact, whose zip extraction follows .. inside entry names; each fetches the
# zip through the REST API and reads it with usabl's own fetcher, which accepts only the expected
# file. No trusted job uses a cache, because a cache can be written by pull request code.
# merge_group is not supported; a missing required check blocks.
jobs:
${ENGINE_JOB}
  build-app:
    # UNTRUSTED. This is the only job that runs pull request code, so it is fenced to the
    # pull_request event, holds no secret, and has a read-only token. Its build_digest output is
    # the head's own word: the judge checks the archive against it on this event and records the
    # digest it scanned in the Result, which binds the verdict to those exact bytes.
    if: github.event_name == 'pull_request'${variant.buildNeedsEngine ? '\n    needs: usabl-engine' : ''}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      build_digest: \${{ steps.pack.outputs.build_digest }}
    steps:
      - name: Checkout pull request head
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${variant.buildSteps}

      - name: Upload the build
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-app-build
          path: \${{ runner.temp }}/usabl-app-build.tar
          if-no-files-found: error
          # Kept a week so an approval days later can still be re-judged.
          retention-days: 7

  usabl-scan:
    # THE TRUSTED JUDGE. It decides the accessibility verdict and runs on both events, so a
    # review re-judges the same head. It never runs head code in Node or a shell. The head is
    # checked out as data into head/. The engine comes from the verified usabl-engine archive and
    # lives under the runner temp directory, outside the head tree, so nothing the head commits,
    # such as a node_modules directory or an .npmrc, can be resolved by it. The head's build runs
    # only as page script, in a sandboxed Chromium whose requests are filtered to the trusted
    # origins. It references no secret and uses no cache.
    needs: [usabl-engine, build-app]
    if: >-
      always() && needs.usabl-engine.result == 'success' &&
      ((github.event_name == 'pull_request' && needs.build-app.result == 'success') ||
      (github.event_name == 'pull_request_review' && needs.build-app.result == 'skipped'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Only the review path uses this: it finds this head's pull_request run and downloads its build.
      actions: read
    outputs:
      # The accessibility verdict travels to usabl-required as a job output, which only this
      # job's steps can set. It starts at fail and only a clean enforce moves it to pass.
      verdict: \${{ steps.verdict.outputs.verdict }}
      result_digest: \${{ steps.verdict.outputs.result_digest }}
    env:
      # The base commit the event names. Serving, scanning, policy, and the comment all read this
      # one commit, so a base branch that moves during the run cannot mix two snapshots.
      BASE_SHA: \${{ github.event.pull_request.base.sha }}
      HEAD_SHA: \${{ github.event.pull_request.head.sha }}
      ENGINE_TREE_DIGEST: \${{ needs.usabl-engine.outputs.engine_tree_digest }}
    steps:
      - name: Checkout pull request head as data
        # Nothing in this tree is executed. It is read for the diff against the trusted base.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          path: head
          fetch-depth: 0
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${installTrustedEngineSteps()}

      - name: Install Chromium for the judge
        working-directory: \${{ runner.temp }}/usabl-engine
        run: |
${ENGINE_CHECK}
          node node_modules/playwright/cli.js install --with-deps chromium

      - name: Find this head's build
        working-directory: \${{ runner.temp }}
        env:
          EVENT_NAME: \${{ github.event_name }}
          GH_TOKEN: \${{ github.token }}
          WORKFLOW_FILE: ${variant.workflowFile}
          WORKFLOW_NAME: ${variant.name}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
        run: |
          # On pull_request the build is in this run.
          if [ "\${EVENT_NAME}" = "pull_request" ]; then
            if ! [[ "\${GITHUB_RUN_ID}" =~ ^[0-9]+$ ]]; then
              echo "this run has no numeric run id; failing closed"
              exit 1
            fi
            echo "BUILD_RUN_ID=\${GITHUB_RUN_ID}" >> "$GITHUB_ENV"
            exit 0
          fi
          # The build runs only on pull_request. Take the newest completed pull_request run of this
          # exact pull request, head repository, head, and base, by its run name, whose latest
          # build-app job succeeded. Every page of runs is searched.
          run_id="$(node <<'NODE'
${indentScript(FIND_BUILD_RUN_SCRIPT, '          ')}
          NODE
          )"
          if ! [[ "\${run_id}" =~ ^[0-9]+$ ]]; then
            echo "no completed pull_request run built this pull request at head \${HEAD_SHA} on base \${BASE_SHA}; failing closed"
            exit 1
          fi
          echo "BUILD_RUN_ID=\${run_id}" >> "$GITHUB_ENV"

${fetchArtifactStep({
  stepName: 'Fetch the build',
  artifact: 'usabl-app-build',
  member: 'usabl-app-build.tar',
  into: 'usabl-download-build',
  maxBytes: ARTIFACT_MAX_BYTES.build,
  runId: '\${{ env.BUILD_RUN_ID }}',
})}

      - name: Verify and unpack the build
        working-directory: \${{ runner.temp }}
        env:
          EVENT_NAME: \${{ github.event_name }}
          BUILD_DIGEST: \${{ needs.build-app.outputs.build_digest }}
          DOWNLOAD_DIR: \${{ runner.temp }}/usabl-download-build
        run: |
          if [ "\${EVENT_NAME}" = "pull_request" ]; then
${verifyDownload('DOWNLOAD_DIR', 'usabl-app-build.tar', 'BUILD_DIGEST', 'build').replace(/^ {10}/gm, '            ')}
          elif [ "$(ls -A "\${DOWNLOAD_DIR}")" != "usabl-app-build.tar" ] || [ -L "\${DOWNLOAD_DIR}/usabl-app-build.tar" ] || [ ! -f "\${DOWNLOAD_DIR}/usabl-app-build.tar" ]; then
            echo "the build artifact is not exactly one regular file named usabl-app-build.tar; failing closed"
            exit 1
          fi
          # On a review the pull_request run's job outputs are out of reach, so there is nothing
          # to check against. A replaced build gains the author nothing they do not already have,
          # because they wrote the build. The judge records the digest it actually scanned.
          echo "USABL_BUILD_DIGEST=$(sha256sum "\${DOWNLOAD_DIR}/usabl-app-build.tar" | cut -d' ' -f1)" >> "$GITHUB_ENV"
          # Regular files and directories only, no absolute path, no .. segment, fresh directory.
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" extract-build --archive "\${DOWNLOAD_DIR}/usabl-app-build.tar" --into "\${RUNNER_TEMP}/usabl-app"

      - name: Fetch the trusted base commit when absent
        working-directory: head
        run: |
          if ! [[ "\${BASE_SHA}" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
            echo "the event base SHA is not a full commit SHA; failing closed"
            exit 1
          fi
          if ! git cat-file -e "\${BASE_SHA}^{commit}" 2> /dev/null; then
            git fetch --no-tags --depth=1 origin "\${BASE_SHA}"
          fi

      - name: Allow the Chromium sandbox
        run: |
          # Ubuntu runners restrict unprivileged user namespaces through AppArmor, and the Chromium
          # sandbox needs them. No head code runs in this job, so this only lets the sandbox start.
          if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          fi

${variant.serveStep}

      - name: Run the judge
        id: usabl
        working-directory: head
        run: |
          mkdir "\${RUNNER_TEMP}/usabl-judge"
          code=0
          # Keep || code=$? on the same line, because a next-line $? becomes 0 under set -e.
          # trusted-ref is the event's base commit, so a PR cannot rewrite policy and pass itself.
          # The engine reads this head tree as data; it is never imported or executed.
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" check --ci --trusted-ref "\${BASE_SHA}" --isolated-browser --json > "\${RUNNER_TEMP}/usabl-judge/usabl-result.json" || code=$?
          echo "exit_code=\${code}" >> "$GITHUB_OUTPUT"

      - name: Stop the build server
        if: always()
        run: |
          if [ -n "\${SERVE_PID:-}" ]; then
            kill "\${SERVE_PID}" || true
          fi

      - name: Validate the Result and resolve the verdict
        id: verdict
        if: always()
        # The runner temp directory, which exists even when an earlier step failed, so the verdict
        # is always published.
        working-directory: \${{ runner.temp }}
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          # The verdict starts at fail and only a valid Result and a clean enforce move it. A
          # Result that fails validation gets no digest, so no other job will read it.
          verdict=fail
          digest=
          # The engine check runs in a subshell, so a mismatch leaves the verdict at fail and still
          # publishes it.
          if (
${ENGINE_CHECK}
          ) && [ -s usabl-judge/usabl-result.json ] && [ -n "\${USABL_EXIT}" ] && (
${VALIDATE_RESULT_SCRIPT}
          ); then
            digest="$(sha256sum usabl-judge/usabl-result.json | cut -d' ' -f1)"
            code=0
            # Keep || code=$? on the same line, because a next-line $? becomes 0 under set -e.
            node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" enforce accessibility < usabl-judge/usabl-result.json || code=$?
            if [ "\${code}" = "0" ]; then
              verdict=pass
            fi
          else
            echo "the judge produced no valid Result; reporting the accessibility verdict as fail"
          fi
          echo "accessibility verdict: \${verdict}"
          echo "verdict=\${verdict}" >> "$GITHUB_OUTPUT"
          echo "result_digest=\${digest}" >> "$GITHUB_OUTPUT"

      - name: Upload Result JSON
        # Uploaded before enforcement, so the comment can explain a failed scan.
        if: always() && steps.verdict.outputs.result_digest != ''
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-result
          path: \${{ runner.temp }}/usabl-judge/usabl-result.json
          if-no-files-found: error
          retention-days: 1

      - name: Enforce accessibility
        if: always()
        env:
          VERDICT: \${{ steps.verdict.outputs.verdict }}
        run: |
          # Never exit 2 here. Guarded-file approval lives on usabl-policy.
          if [ "\${VERDICT}" != "pass" ]; then
            echo "accessibility verdict is \${VERDICT:-missing}; see the usabl comment for the barriers"
            exit 1
          fi

  gate-comment:
    # Presentation only: it posts the sticky comment and decides nothing. It runs no head code and
    # no browser, and it believes the Result only after checking it against result_digest, the
    # judge's own job output. It runs after a failed scan too, whenever the judge produced a valid
    # Result, so a regression is explained on the pull request.
    needs: [usabl-engine, usabl-scan]
    if: >-
      always() && github.event_name == 'pull_request' &&
      needs.usabl-engine.result == 'success' && needs.usabl-scan.outputs.result_digest != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Only the artifact fetch uses this: it lists this run's artifacts and downloads the Result.
      actions: read
      pull-requests: write
    env:
      ENGINE_TREE_DIGEST: \${{ needs.usabl-engine.outputs.engine_tree_digest }}
    steps:
      - name: Checkout trusted base config
        # The base commit only, and only the config, for the comment noise budget.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          path: base
          sparse-checkout: usabl.config.json
          sparse-checkout-cone-mode: false
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${installTrustedEngineSteps()}

${fetchArtifactStep({
  stepName: 'Fetch Result JSON',
  artifact: 'usabl-result',
  member: 'usabl-result.json',
  into: 'usabl-download-result',
  maxBytes: ARTIFACT_MAX_BYTES.result,
})}

      - name: Verify Result JSON and render the comment
        working-directory: \${{ runner.temp }}
        env:
          RESULT_DIGEST: \${{ needs.usabl-scan.outputs.result_digest }}
          DOWNLOAD_DIR: \${{ runner.temp }}/usabl-download-result
        run: |
${verifyDownload('DOWNLOAD_DIR', 'usabl-result.json', 'RESULT_DIGEST', 'Result')}
${ENGINE_CHECK}
          code=0
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" comment --config "\${GITHUB_WORKSPACE}/base/usabl.config.json" < "\${DOWNLOAD_DIR}/usabl-result.json" > usabl-comment.md || code=$?
          if [ ! -s usabl-comment.md ] || ! grep -q '<!-- usabl-report -->' usabl-comment.md; then
            echo "comment renderer produced no usabl markdown (exit \${code})"
            exit 1
          fi

      - name: Show the comment in the job summary for a fork
        # A pull request from a fork gets a token that cannot write to the pull request, so the
        # comment goes to this run's summary instead. The comment decides nothing either way.
        if: github.event.pull_request.head.repo.full_name != github.repository
        env:
          COMMENT_PATH: \${{ runner.temp }}/usabl-comment.md
        run: cat "\${COMMENT_PATH}" >> "$GITHUB_STEP_SUMMARY"

      - name: Post sticky PR comment
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8
        env:
          COMMENT_PATH: \${{ runner.temp }}/usabl-comment.md
        with:
          script: |
            const fs = require('node:fs');
            const marker = '<!-- usabl-report -->';
            const body = fs.readFileSync(process.env.COMMENT_PATH, 'utf8');
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, {
              owner,
              repo,
              issue_number,
              per_page: 100,
            });
            const existing = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.includes(marker));
            if (existing) {
              await github.rest.issues.updateComment({
                owner,
                repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body,
              });
            }

  usabl-policy:
    # The policy verdict. It re-runs on pull_request_review so a CODEOWNERS approval or dismissal
    # flips the gate. It must never check out or execute PR head code: it reads the head only as
    # git objects and decides from the trusted base ref, CODEOWNERS, and the reviews API. Its
    # engine is the verified usabl-engine archive, so there is no second engine checkout here.
    # Do not make this the required check on its own: it returns success
    # whenever no guarded path diverged, which says nothing about accessibility.
    needs: [usabl-engine, usabl-scan]
    if: always() && needs.usabl-engine.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Only the artifact fetch uses this: it lists this run's artifacts and downloads the Result.
      actions: read
      pull-requests: read
    env:
      BASE_SHA: \${{ github.event.pull_request.base.sha }}
      PR_NUMBER: \${{ github.event.pull_request.number }}
      ENGINE_TREE_DIGEST: \${{ needs.usabl-engine.outputs.engine_tree_digest }}
    steps:
      - name: Checkout trusted base-ref policy
        # Check out the base commit, never the PR head. This working tree is trusted.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 0

      - name: Fetch head objects without checkout
        run: |
          # PR_NUMBER comes from the event as an integer. Guard it anyway before it
          # reaches a ref path, so a malformed value can never inject a fetch refspec.
          case "\${PR_NUMBER}" in
            ''|*[!0-9]*)
              echo "pull request number is not numeric; failing closed"
              exit 1
              ;;
          esac
          # The base commit is this checkout. Bring the PR head as objects only. enforce policy
          # reads blob contents with git show and git ls-tree, which never check out or execute
          # the head, so no PR code runs.
          git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head"

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${installTrustedEngineSteps()}

${fetchArtifactStep({
  stepName: 'Fetch Result JSON',
  artifact: 'usabl-result',
  member: 'usabl-result.json',
  into: 'usabl-download-result',
  maxBytes: ARTIFACT_MAX_BYTES.result,
})}

      - name: Enforce policy
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          RESULT_DIGEST: \${{ needs.usabl-scan.outputs.result_digest }}
          DOWNLOAD_DIR: \${{ runner.temp }}/usabl-download-result
        run: |
          # The Result on stdin is consumed only for the exit-4 crash short-circuit, never to skip
          # owners, and only after it matches the judge's result_digest output.
${verifyDownload('DOWNLOAD_DIR', 'usabl-result.json', 'RESULT_DIGEST', 'Result')}
          # Git refs and CODEOWNERS are the source of truth.
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" enforce policy --trusted-ref "\${BASE_SHA}" < "\${DOWNLOAD_DIR}/usabl-result.json"

  ${REQUIRED_GATE_JOB}:
    # THE REQUIRED STATUS CHECK. Require this one in branch protection or your ruleset.
    #
    # Requiring any other job leaves a hole. usabl-scan holds the accessibility verdict as data
    # but can succeed with a failing verdict on a cancelled run, and usabl-policy returns success
    # whenever no guarded path diverged, which says nothing about accessibility. Only this job
    # checks every job's shape for the event and the judge's verdict together.
    #
    # always() is load-bearing. GitHub counts a skipped job as a satisfied required check, so
    # an aggregate that could be skipped would be an open gate. This one always runs and
    # always decides.
    needs: [usabl-engine, build-app, usabl-scan, gate-comment, usabl-policy]
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Decide the merge gate
        working-directory: \${{ runner.temp }}
        env:
          EVENT_NAME: \${{ github.event_name }}
          ENGINE_RESULT: \${{ needs.usabl-engine.result }}
          BUILD_RESULT: \${{ needs.build-app.result }}
          SCAN_RESULT: \${{ needs.usabl-scan.result }}
          COMMENT_RESULT: \${{ needs.gate-comment.result }}
          POLICY_RESULT: \${{ needs.usabl-policy.result }}
          ACCESSIBILITY_VERDICT: \${{ needs.usabl-scan.outputs.verdict }}
        run: |
          node <<'NODE'
${EMBEDDED_GATE_SCRIPT}
          NODE
`;
}

// The app gate. Five trust boundaries in six jobs: the pinned engine, the untrusted build, the
// trusted judge, the comment, the policy decision, and the one required aggregate. The build
// command and output directory are repository variables (USABL_APP_BUILD_COMMAND, default
// "npm run build"; USABL_APP_BUILD_DIR, default "dist"), so the file stays byte-stable and the
// engine ref remains the only value classifyGateWorkflow must reason about.
export const USABL_GATE_WORKFLOW = gateWorkflow({
  name: 'usabl-gate',
  workflowFile: 'usabl-gate.yml',
  buildSteps: APP_BUILD_STEPS,
  buildNeedsEngine: true,
  serveStep: APP_SERVE_STEP,
});

export const USABL_DOCS_GATE_WORKFLOW_PATH = '.github/workflows/usabl-docs-gate.yml';

// The docs gate is the same template for a rendered-documentation repository. Only the build
// and the serve differ: the build runs an operator-supplied command and packs the rendered HTML
// directory, and the judge serves it on a loopback port from a repository variable. The build
// command, the built-HTML directory, and the serve port are repository variables
// (USABL_DOCS_BUILD_COMMAND, USABL_DOCS_BUILT_ROOT, USABL_DOCS_SERVE_PORT), so this file stays
// byte-stable. usabl.docs.json docsBaseUrl at the trusted ref must point at that port.
export const USABL_DOCS_GATE_WORKFLOW = gateWorkflow({
  name: 'usabl-docs-gate',
  workflowFile: 'usabl-docs-gate.yml',
  buildSteps: DOCS_BUILD_STEPS,
  buildNeedsEngine: false,
  serveStep: DOCS_SERVE_STEP,
});

export type CiPlan =
  | { action: 'write'; path: string; contents: string }
  // pinnedTo is set when the file on disk is the usabl draft pinned to a commit other than the one
  // this run would write. usabl leaves that pin alone, because someone chose it.
  | { action: 'already-wired'; path: string; pinnedTo?: string }
  | { action: 'refuse'; path: string; difference: string };

function describeDifference(actual: string, expected: string): string {
  // High-level only. We report where the files first diverge, not a full diff, so the
  // operator knows to reconcile by hand without us guessing at their intent.
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const max = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < max; i += 1) {
    if (actualLines[i] !== expectedLines[i]) {
      return `the first difference is at line ${i + 1} (existing file has ${actualLines.length} lines, the usabl draft has ${expectedLines.length} lines)`;
    }
  }
  return `the existing file has ${actualLines.length} lines and the usabl draft has ${expectedLines.length} lines`;
}

// planCi, planDocsCi, and planHistoryCi answer the same question against different targets: given
// the placeholder draft for a workflow, its path, and the engine commit to pin (or null to keep the
// placeholder), may usabl write, or must it refuse? The logic is identical, so it lives here once.
export async function planWorkflow(
  fs: InstallFs,
  path: string,
  placeholderDraft: string,
  engineRef: string | null,
): Promise<CiPlan> {
  const draft = engineRef === null ? placeholderDraft : pinEngineRef(placeholderDraft, engineRef);
  const raw = await fs.readFile(path);
  if (raw === null) {
    return { action: 'write', path, contents: draft };
  }
  if (raw === draft) {
    return { action: 'already-wired', path };
  }
  // usabl's own draft, unedited, with the placeholder still in it. Filling the pin there changes
  // only the line the operator was told to edit, so nothing anyone wrote is lost.
  if (engineRef !== null && raw === placeholderDraft) {
    return { action: 'write', path, contents: draft };
  }
  // The draft pinned to some other commit. Someone chose that pin, so it stays.
  const onDisk = matchWorkflow(raw, placeholderDraft);
  if (onDisk.state === 'wired' && onDisk.ref !== null) {
    return { action: 'already-wired', path, pinnedTo: onDisk.ref };
  }
  // A hand-tuned workflow is security-critical. We never overwrite it; we describe the gap
  // at a high level and tell the operator to reconcile by hand.
  return {
    action: 'refuse',
    path,
    difference: describeDifference(raw, draft),
  };
}

export async function planCi(fs: InstallFs, engineRef: string | null = null): Promise<CiPlan> {
  return planWorkflow(fs, USABL_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW, engineRef);
}

export async function planDocsCi(fs: InstallFs, engineRef: string | null = null): Promise<CiPlan> {
  return planWorkflow(fs, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_DOCS_GATE_WORKFLOW, engineRef);
}

/** The commit to pin for this build, or null to keep the placeholder. */
export function engineRefFor(pin: EnginePin): string | null {
  return pin.kind === 'filled' ? pin.sha : null;
}

/** The fact the report states when the engine is pinned to this build's commit. */
function pinNote(pin: EnginePin & { kind: 'filled' }): string {
  return `The engine is pinned to usabl-dev/usabl commit ${pin.sha}, the commit this usabl ${pin.version} was built from. If that commit cannot be fetched from usabl-dev/usabl, the usabl-engine job fails and the gate blocks.`;
}

/** The step the report lists when files still hold the placeholder: why, and the line in each. */
function pinStep(reason: string, placeholderFiles: ReadonlyArray<{ path: string; draft: string }>): string {
  const where = placeholderFiles.map((file) => `line ${engineRefLineNumber(file.draft)} of ${file.path}`).join(' and ');
  return `Pin the engine. The engine ref is still the placeholder ${ENGINE_REF_PLACEHOLDER}, because ${reason}. Until you pin a commit, the usabl-engine job fails and the gate blocks. Edit ${where}: replace ${ENGINE_REF_PLACEHOLDER} with a full 40-character commit SHA from usabl-dev/usabl that you trust.`;
}

// What the report says about a file left alone because someone already pinned it.
function keptPinReport(path: string, pinnedTo: string, pin: EnginePin, draft: string): string {
  const built = pin.kind === 'filled' ? ` This usabl was built from ${pin.sha}.` : '';
  return `${path} already matches the usabl draft, pinned to engine commit ${pinnedTo}. No change.${built} usabl never moves a pin you chose. To move it, edit line ${engineRefLineNumber(draft)}.`;
}

// Any pull request, from a branch or a fork, runs this workflow as it changed it. So the required
// check is evidence only on a pull request that leaves .github/workflows alone, and what stops one
// that edits it is a code owner's approval.
const WORKFLOW_BOUNDARY =
  'Any pull request, from a branch or a fork, runs this workflow as the pull request changed it, so one that edits .github/workflows can make ' +
  `"${REQUIRED_GATE_JOB}" pass whatever it judged; its verdict is not evidence. Protect the gate with code owners: add "/.github/workflows/ @your-login" ` +
  'and every guarded path to .github/CODEOWNERS, and on the protected branch require review from code owners, at least one approval, and dismissal of ' +
  'stale approvals on push. "usabl install --branch-rule" prints and checks the full setting.';

const PUBLIC_ENGINE =
  'The engine comes from the public usabl-dev/usabl repository, so the gate needs no secret, and a pull request from a fork runs it the same way. A fork cannot write to its pull request, so its usabl comment appears in the run summary instead.';

const REQUIRED_CHECK_NOTE = `"${REQUIRED_GATE_JOB}" is the only job that checks every gate job and the judge's verdict together, so requiring any other job lets an accessibility regression merge.`;

const BRANCH_RULE_STEP = `Add the branch rule. Run "usabl install --branch-rule": it prints the CODEOWNERS lines and the branch setting that make "${REQUIRED_GATE_JOB}" the required check. Apply them, then run it again to verify.`;

const OPEN_PR_STEP = `Open a pull request. The gate runs on it, and "${REQUIRED_GATE_JOB}" reports the result.`;

/** One workflow file after its plan was applied: the outcome, and whether it holds the placeholder. */
export interface AppliedWorkflow {
  result: InstallResult;
  draft: string;
  holdsPlaceholder: boolean;
}

/**
 * Apply one plan. The result message is the one-line outcome for this file; composeCiReport adds
 * what the run means and what is left to do. label names the workflow in the no-change line.
 */
export async function applyWorkflowPlan(
  fs: InstallFs,
  plan: CiPlan,
  pin: EnginePin,
  draft: string,
  label: string,
): Promise<AppliedWorkflow> {
  if (plan.action === 'write') {
    await fs.writeFile(plan.path, plan.contents);
    return {
      result: { exitCode: 0, action: 'written', path: plan.path, message: `Wrote ${plan.path}.` },
      draft,
      holdsPlaceholder: plan.contents.split('\n').includes(ENGINE_REF_LINE),
    };
  }
  if (plan.action === 'already-wired') {
    return {
      result: {
        exitCode: 0,
        action: 'already-wired',
        path: plan.path,
        message:
          plan.pinnedTo === undefined
            ? `${plan.path} already matches the usabl ${label}. No change.`
            : keptPinReport(plan.path, plan.pinnedTo, pin, draft),
      },
      draft,
      // Identical to the draft this run planned, which holds the placeholder only without a commit.
      holdsPlaceholder: plan.pinnedTo === undefined && pin.kind === 'placeholder',
    };
  }
  return {
    result: {
      exitCode: 2,
      action: 'refused',
      path: plan.path,
      message: `Refusing to overwrite ${plan.path}: it differs from the usabl draft, and ${plan.difference}. Reconcile it by hand; usabl never overwrites a hand-tuned security workflow.`,
    },
    draft,
    holdsPlaceholder: false,
  };
}

/**
 * The report for one install run. It states each file's outcome, then the facts that matter for
 * what was written, then only the steps still needed: the pin when a file holds the placeholder,
 * the setup steps the caller found, and, when anything was written, commit, the branch rule, and a
 * pull request. The result exits 2 when any file was refused.
 */
export function composeCiReport(input: {
  applied: readonly AppliedWorkflow[];
  pin: EnginePin;
  notes: readonly string[];
  setupSteps: readonly string[];
}): InstallResult {
  const results = input.applied.map((entry) => entry.result);
  const written = results.filter((result) => result.action === 'written');
  const placeholderFiles = input.applied
    .filter((entry) => entry.holdsPlaceholder)
    .map((entry) => ({ path: entry.result.path, draft: entry.draft }));

  const steps: string[] = [];
  if (placeholderFiles.length > 0 && input.pin.kind === 'placeholder') {
    steps.push(pinStep(input.pin.reason, placeholderFiles));
  }
  steps.push(...input.setupSteps);
  if (written.length > 0) {
    steps.push(`Review and commit ${written.map((result) => result.path).join(' and ')}.`, BRANCH_RULE_STEP, OPEN_PR_STEP);
  }

  const notes = written.length > 0 ? [...(input.pin.kind === 'filled' ? [pinNote(input.pin)] : []), ...input.notes] : [];
  const sections = [results.map((result) => result.message).join('\n')];
  if (notes.length > 0) sections.push(notes.join('\n'));
  if (steps.length > 0) sections.push(['Next steps:', ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n'));

  const refused = results.some((result) => result.action === 'refused');
  const first = results[0];
  return {
    exitCode: refused ? 2 : 0,
    action: refused ? 'refused' : written.length > 0 ? 'written' : 'already-wired',
    path: first?.path ?? '',
    message: sections.join('\n\n'),
  };
}

/** The facts the app gate report states once something is written. */
export function appGateNotes(app: AppOrigin): string[] {
  const origin = appOriginReport(app);
  return [
    PUBLIC_ENGINE,
    'The untrusted build-app job builds the app with "npm run build" into dist. If yours differs, set the repository variables USABL_APP_BUILD_COMMAND and USABL_APP_BUILD_DIR.',
    ...('note' in origin ? [origin.note] : []),
    REQUIRED_CHECK_NOTE,
    WORKFLOW_BOUNDARY,
  ];
}

/** The setup step the app origin needs, when appBaseUrl is not one the judge can serve yet. */
export function appGateSetupSteps(app: AppOrigin): string[] {
  const origin = appOriginReport(app);
  return 'step' in origin ? [origin.step] : [];
}

// pin is the engine pin this run planned with, so the report says what was written. The default is
// the placeholder, which is what a plan made without a commit writes.
export async function writeCi(fs: InstallFs, plan: CiPlan, pin: EnginePin = NO_BUILD_RECORD): Promise<InstallResult> {
  const app = await readAppOrigin(fs);
  return composeCiReport({
    applied: [await applyWorkflowPlan(fs, plan, pin, USABL_GATE_WORKFLOW, 'gate workflow')],
    pin,
    notes: appGateNotes(app),
    setupSteps: appGateSetupSteps(app),
  });
}

export async function writeDocsCi(fs: InstallFs, plan: CiPlan, pin: EnginePin = NO_BUILD_RECORD): Promise<InstallResult> {
  return composeCiReport({
    applied: [await applyWorkflowPlan(fs, plan, pin, USABL_DOCS_GATE_WORKFLOW, 'docs gate workflow')],
    pin,
    notes: [
      PUBLIC_ENGINE,
      'The judge serves the built HTML itself with usabl serve-build.',
      REQUIRED_CHECK_NOTE,
      WORKFLOW_BOUNDARY,
    ],
    setupSteps: [
      'Set three repository variables the docs gate reads: USABL_DOCS_BUILD_COMMAND (for example "ccutil compile"), USABL_DOCS_BUILT_ROOT (the directory the build renders HTML into), and USABL_DOCS_SERVE_PORT (a free port).',
      'Point docsBaseUrl in usabl.docs.json at http://127.0.0.1:<USABL_DOCS_SERVE_PORT> so the scan targets the served docs, and commit it.',
    ],
  });
}

// A pin-aware recognizer for `usabl doctor`, additive to the install plan above and next to
// the constants it needs. planCi answers a different question: "may usabl write, or must it
// refuse?", so it treats the draft (sentinel and all) as the one shape it may no-op on and
// anything else as a hand-tuned file to leave alone. doctor asks "is this surface
// functionally correct?", and the honest answer turns on the engine ref. The draft ships
// unpinned (the sentinel), a correctly wired workflow carries a real commit SHA at every
// engine-ref line, and any other change is drift. classifyGateWorkflow reports those states
// without changing planCi or writeCi, so recognition stays centralized here rather than being
// re-derived, more weakly, inside doctor.
export type GateWorkflowState = 'missing' | 'wired' | 'unpinned' | 'drifted';

// Identify an engine-ref line by matching the DRAFT. A draft line is a variable pin only when
// it is a ref line whose value is the sentinel. Every other draft line is fixed and must be
// reproduced byte for byte. Returns the leading indent so the actual line can be required to
// keep it, or null when the draft line is not an engine-ref line.
function draftEngineRefIndent(draftLine: string): string | null {
  const match = /^(\s*)ref:\s*(\S+)\s*$/.exec(draftLine);
  if (match === null || match[2] !== ENGINE_REF_PLACEHOLDER) {
    return null;
  }
  return match[1] ?? '';
}

// The number of engine-ref lines a draft is built to carry. classifyWorkflow learns which
// on-disk lines are variable pins by finding the draft lines whose value is the sentinel, so
// this count is a load-bearing coupling: if a draft were ever shipped pre-pinned, or the
// sentinel renamed, draftEngineRefIndent would match nothing, refValues would be empty, and
// every real workflow (even a correctly pinned one) would classify as drifted, degrading
// doctor to always-drifted with no false wired. A guard-test asserts each draft still carries
// exactly this many sentinel ref lines, so a draft edit that breaks the recognizer fails a
// test rather than silently rotting the signal.
export const EXPECTED_ENGINE_REF_LINES = 1;

// Count the sentinel engine-ref lines in a draft, using the same predicate classifyWorkflow
// uses to find them, so the guard-test and the classifier can never disagree about what a
// pin line is.
export function countDraftEngineRefLines(draft: string): number {
  return draft.split('\n').filter((line) => draftEngineRefIndent(line) !== null).length;
}

// The recognizer is draft-relative: it compares the on-disk file against a specific draft,
// so the app gate and the docs gate share one implementation and each passes its own draft.
export function classifyWorkflow(raw: string | null, draft: string): GateWorkflowState {
  return matchWorkflow(raw, draft).state;
}

// The classification, with the engine ref value the classifier itself read from the file. Callers
// that report the pin take it from here, so the value they print is the value that was matched.
export function matchWorkflow(raw: string | null, draft: string): { state: GateWorkflowState; ref: string | null } {
  const state = classifyWorkflowLines(raw, draft);
  if (state.refValues === null) return { state: state.state, ref: null };
  return { state: state.state, ref: state.refValues[0] ?? null };
}

function classifyWorkflowLines(raw: string | null, draft: string): { state: GateWorkflowState; refValues: string[] | null } {
  const drifted = { state: 'drifted' as const, refValues: null };
  // Recognition never fails toward success. Only a workflow that matches the draft line for
  // line, differing solely at the engine-ref lines and only to the same real 40-character
  // commit SHA, reads as wired. Everything less confident lands on missing, unpinned, or
  // drifted, never wired.
  if (raw === null) {
    return { state: 'missing', refValues: null };
  }
  const actualLines = raw.split('\n');
  const draftLines = draft.split('\n');
  // A different line count is a structural change, never just a pin: drifted.
  if (actualLines.length !== draftLines.length) {
    return drifted;
  }
  const refValues: string[] = [];
  for (let i = 0; i < draftLines.length; i += 1) {
    const draftLine = draftLines[i] ?? '';
    const actualLine = actualLines[i] ?? '';
    const indent = draftEngineRefIndent(draftLine);
    if (indent === null) {
      // A fixed line. It is correct only when it matches the draft exactly.
      if (draftLine !== actualLine) {
        return drifted;
      }
      continue;
    }
    // An engine-ref line. The pin value is variable, but the line must still be a ref line at
    // the same indent. Anything else here is a structural edit, not a pin: drifted.
    const actualMatch = /^(\s*)ref:\s*(\S+)\s*$/.exec(actualLine);
    if (actualMatch === null || actualMatch[1] !== indent) {
      return drifted;
    }
    refValues.push(actualMatch[2] ?? '');
  }
  // The draft always carries exactly EXPECTED_ENGINE_REF_LINES engine-ref lines. If none matched, the draft itself
  // changed shape underneath us; treat that as drifted rather than guess.
  if (refValues.length === 0) {
    return drifted;
  }
  const first = refValues[0] ?? '';
  const allSame = refValues.every((value) => value === first);
  if (!allSame) {
    // The engine-ref lines disagree, for example one pinned and one still the sentinel. That
    // is an inconsistent pin, not a confident wired.
    return drifted;
  }
  if (/^[0-9a-f]{40}$/.test(first)) {
    return { state: 'wired', refValues };
  }
  if (first === ENGINE_REF_PLACEHOLDER) {
    return { state: 'unpinned', refValues };
  }
  // A single consistent ref that is neither a full commit SHA nor the sentinel: a branch, a
  // tag, or a short SHA. usabl cannot confirm that as a trusted pin, so: drifted.
  return drifted;
}

export function classifyGateWorkflow(raw: string | null): GateWorkflowState {
  return classifyWorkflow(raw, USABL_GATE_WORKFLOW);
}

export function classifyDocsGateWorkflow(raw: string | null): GateWorkflowState {
  return classifyWorkflow(raw, USABL_DOCS_GATE_WORKFLOW);
}
