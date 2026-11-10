/**
 * The default-branch workflow `usabl install --ci` writes beside the pull request gate. It scans
 * the default branch and records what it saw on the usabl/history branch, which is what lets a
 * fixed accessibility barrier close its slot in the accepted debt without anyone running
 * `usabl floor prune`.
 *
 * Three jobs, so the job that runs the application never holds write access:
 * - usabl-engine builds the pinned engine, with the same job the pull request gate uses.
 * - history-scan checks out the default branch, starts the application on the origin of appBaseUrl
 *   in that branch's usabl.config.json, runs `usabl history record`, and uploads the record. It runs application
 *   code, so it reads only.
 * - history-append downloads the record, adds it to the history branch with `usabl history append`,
 *   and pushes without force. It runs only the engine archive it checked against the engine job's
 *   digest, so it is the one job that writes. It needs `contents: write`, the one permission
 *   tracking needs. GitHub cannot narrow that to one branch; a ruleset on usabl/history can.
 *
 * Pull requests need nothing new. The gate job checks out with fetch-depth 0, which fetches every
 * branch, so origin/usabl/history is already there when the check reads it. A team that cannot
 * grant the write permission leaves this workflow out and keeps today's behavior, and every run
 * says tracking is off.
 *
 * Like the gate, this writes only when absent, no-ops when identical, and refuses to overwrite a
 * workflow that differs.
 */
import type { InstallFs, InstallResult } from './index.js';
import { ARTIFACT_MAX_BYTES, ENGINE_CHECK, fetchArtifactStep } from './artifact-fetch.js';
import { NO_BUILD_RECORD, type EnginePin } from './build-info.js';
import { CONFIG_PATH, hasDevScript, readAppOrigin } from './app-origin.js';
import {
  filesOnDefaultBranch,
  findDefaultBranch,
  isSafeBranchName,
  NO_GIT,
  presentFiles,
  ROUTES_PATH,
  type InstallGit,
} from './repo-git.js';
import {
  appGateNotes,
  appGateSetupSteps,
  applyWorkflowPlan,
  classifyBranchedWorkflow,
  composeCiReport,
  EARLIER_ENGINE_TEXT,
  earlierForm,
  ENGINE_JOB,
  engineRefFor,
  PLACE_ENGINE_BESIDE_APP,
  type EarlierText,
  planWorkflow,
  TRUSTED_ENGINE_STEP,
  trustedEngineSteps,
  UNPACK_ENGINE_IN_TEMP,
  type CiPlan,
  type GateWorkflowState,
} from './ci.js';
import {
  branchAgreementStep,
  branchFor,
  branchNamedBy,
  branchReport,
  DOCS_GATE_BRANCHED,
  filesFirstStep,
  GATE_BRANCHED,
  type BranchedWorkflow,
} from './workflow-branch.js';

export const USABL_HISTORY_WORKFLOW_PATH = '.github/workflows/usabl-history.yml';

// The scan job also places the engine at ../usabl, for an app whose lockfile installs it from there.
const HISTORY_SCAN_ENGINE_UNPACK = `${UNPACK_ENGINE_IN_TEMP}
${PLACE_ENGINE_BESIDE_APP}`;

/**
 * The history workflow for an app whose default branch is `branch`. The name goes into the trigger
 * and into the scan job's `if:`, so only a plain name is taken: letters, digits, and . _ - /. It is
 * written quoted, so YAML reads it as text even when it looks like a number.
 */
export function historyWorkflow(branch: string): string {
  if (!isSafeBranchName(branch)) {
    throw new Error('the history workflow branch must be letters, digits, and . _ - / only');
  }
  return `name: usabl-history

on:
  push:
    branches: ["${branch}"]
  schedule:
    # A second scan of an unchanged default branch confirms a fix without waiting for the next merge.
    - cron: "17 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

# One scan and one append at a time, so two records never race for the same parent commit.
concurrency:
  group: usabl-history
  cancel-in-progress: false

# The engine is built once, by the same job the pull request gate uses, and each later job checks
# the archive against that job's digest output before it runs it. The scan job runs application
# code, which on a hosted runner may be able to replace artifacts in the run, so the job that
# writes never runs an engine it did not check. No job unpacks an artifact with
# actions/download-artifact, whose zip extraction follows .. inside entry names; each uses usabl's
# own fetcher, which accepts only the expected file. No job uses a cache.
jobs:
${ENGINE_JOB}

  history-scan:
    # Starts the application from the default branch and scans every screen. It runs application
    # code, so it never gets write access. It writes the record to a file and nothing to git.
    if: github.ref == 'refs/heads/${branch}'
    needs: usabl-engine
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Only the artifact fetch uses this: it lists this run's artifacts and downloads the engine.
      actions: read
    env:
      ENGINE_TREE_DIGEST: \${{ needs.usabl-engine.outputs.engine_tree_digest }}
    steps:
      - name: Checkout the default branch
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${trustedEngineSteps(TRUSTED_ENGINE_STEP, HISTORY_SCAN_ENGINE_UNPACK)}

      - name: Install Chromium for engine checks
        working-directory: \${{ runner.temp }}/usabl-engine
        run: |
${ENGINE_CHECK}
          node node_modules/playwright/cli.js install --with-deps chromium

      - name: Allow the Chromium sandbox
        run: |
          # Ubuntu runners restrict unprivileged user namespaces through AppArmor, and the Chromium
          # sandbox needs them.
          if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          fi

      - name: Install application dependencies
        run: npm ci --ignore-scripts

      - name: Read the app origin from usabl.config.json
        run: |
          # The scan reads appBaseUrl from this checkout of the default branch, so the app starts on
          # that origin, never on a port this file assumes. Only an http origin on loopback with an
          # explicit port is taken, the same shape the judge needs. Anything else stops here.
          node <<'NODE'
          const fs = require('node:fs');
          const fail = (why) => {
            console.error('usabl-history: ' + why + '; failing closed');
            process.exit(1);
          };
          let config;
          try {
            config = JSON.parse(fs.readFileSync('usabl.config.json', 'utf8'));
          } catch {
            fail('usabl.config.json is missing or is not JSON');
          }
          const base = config !== null && typeof config === 'object' ? config.appBaseUrl : undefined;
          if (typeof base !== 'string') fail('usabl.config.json has no appBaseUrl string');
          let url;
          try {
            url = new URL(base);
          } catch {
            fail('appBaseUrl in usabl.config.json is not a URL');
          }
          if (url.protocol !== 'http:') fail('appBaseUrl in usabl.config.json must use http');
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            fail('appBaseUrl in usabl.config.json must be a loopback host (127.0.0.1, localhost, or [::1])');
          }
          if (url.port === '') fail('appBaseUrl in usabl.config.json must name an explicit port');
          const host = url.hostname === '[::1]' ? '::1' : url.hostname;
          fs.appendFileSync(process.env.GITHUB_ENV, 'USABL_APP_HOST=' + host + '\\n' + 'USABL_APP_PORT=' + url.port + '\\n' + 'USABL_APP_ORIGIN=' + url.origin + '\\n');
          console.log('usabl-history: the app starts on ' + url.origin + ', the origin of appBaseUrl');
          NODE

      - name: Start application on localhost
        run: |
          npm run dev -- --host "\${USABL_APP_HOST}" --port "\${USABL_APP_PORT}" > "\${RUNNER_TEMP}/usabl-vite.log" 2>&1 &
          echo "VITE_PID=$!" >> "$GITHUB_ENV"

      - name: Wait for application readiness
        run: |
          for _ in $(seq 1 60); do
            if curl -fsS "\${USABL_APP_ORIGIN}" > /dev/null; then
              exit 0
            fi
            sleep 1
          done
          echo "application did not start on \${USABL_APP_ORIGIN}"
          cat "\${RUNNER_TEMP}/usabl-vite.log"
          exit 1

      - name: Scan the default branch and write the history record
        run: |
${ENGINE_CHECK}
          node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" history record --out usabl-history-record.json

      - name: Stop application server
        if: always()
        run: |
          if [ -n "\${VITE_PID:-}" ]; then
            kill "\${VITE_PID}" || true
          fi

      - name: Upload the history record
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-history-record
          path: usabl-history-record.json
          if-no-files-found: error
          retention-days: 1

  history-append:
    # Adds the record to the usabl/history branch. It runs no application code and no npm, only the
    # checked engine, so it is the one job that may write. Pushes never force, so a record is never
    # lost. The record itself came from a job that ran application code; a forged record can only
    # make later runs stricter, never greener, because the history can only lower the debt a run
    # accepts.
    needs: [usabl-engine, history-scan]
    runs-on: ubuntu-latest
    permissions:
      contents: write
      # Only the artifact fetch uses this: it lists this run's artifacts and downloads them.
      actions: read
    env:
      ENGINE_TREE_DIGEST: \${{ needs.usabl-engine.outputs.engine_tree_digest }}
    steps:
      - name: Checkout the default branch without running it
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          # setup-node turns npm caching on by itself when package.json names npm. A cache can be
          # written by pull request code, so every job turns it off by name.
          package-manager-cache: false

${trustedEngineSteps(TRUSTED_ENGINE_STEP, UNPACK_ENGINE_IN_TEMP)}

${fetchArtifactStep({
  stepName: 'Fetch the history record',
  artifact: 'usabl-history-record',
  member: 'usabl-history-record.json',
  into: 'usabl-download-record',
  maxBytes: ARTIFACT_MAX_BYTES.record,
})}

      - name: Append the record and push the history branch
        env:
          RECORD_PATH: \${{ runner.temp }}/usabl-download-record/usabl-history-record.json
        run: |
          # Fetch the branch fresh on every try, append on top of it, and push without force. A
          # push that loses a race is refused, so the loop fetches the newer branch and tries again.
${ENGINE_CHECK}
          for attempt in 1 2 3; do
            git fetch --no-tags origin "+refs/heads/usabl/history:refs/remotes/origin/usabl/history" || echo "no usabl/history branch yet; the first record starts it"
            node "\${RUNNER_TEMP}/usabl-engine/dist/cli.js" history append "\${RECORD_PATH}"
            if git push origin "refs/heads/usabl/history:refs/heads/usabl/history"; then
              exit 0
            fi
            echo "push attempt \${attempt} was refused; fetching the newer history and trying again"
          done
          echo "could not push the history record after 3 attempts"
          exit 1
`;
}

/** The history workflow for an app whose default branch is main. */
export const USABL_HISTORY_WORKFLOW = historyWorkflow('main');

// What an earlier 0.3.0 build wrote in place of these parts: comments and step names that said main
// for the default branch, and the engine step with no guard for a repository named usabl.
const EARLIER_HISTORY_TEXT: EarlierText = [
  [
    '    # A second scan of an unchanged default branch confirms a fix without waiting for the next merge.\n',
    '    # A second scan of an unchanged main confirms a fix without waiting for the next merge.\n',
  ],
  [
    '    # Starts the application from the default branch and scans every screen. It runs application\n    # code, so it never gets write access.',
    '    # Starts the application from main and scans every screen. It runs application code, so it\n    # never gets write access.',
  ],
  ['      - name: Checkout the default branch\n', '      - name: Checkout main\n'],
  [
    '          # The scan reads appBaseUrl from this checkout of the default branch, so the app starts on\n          # that origin, never on a port this file assumes. Only an http origin on loopback with an\n          # explicit port is taken,',
    '          # The scan reads appBaseUrl from this checkout of main, so the app starts on that origin,\n          # never on a port this file assumes. Only an http origin on loopback with an explicit port\n          # is taken,',
  ],
  ['      - name: Scan the default branch and write the history record\n', '      - name: Scan main and write the history record\n'],
  ['      - name: Checkout the default branch without running it\n', '      - name: Checkout main without running it\n'],
  ...EARLIER_ENGINE_TEXT,
];

/** The history workflow an earlier 0.3.0 build wrote for `branch`. */
export function earlierHistoryWorkflow(branch: string): string {
  return earlierForm(historyWorkflow(branch), EARLIER_HISTORY_TEXT);
}

export const HISTORY_BRANCHED: BranchedWorkflow = {
  path: USABL_HISTORY_WORKFLOW_PATH,
  event: 'push',
  runsOn: 'runs on pushes to',
  ifWrong: 'the history scan never runs',
  draftFor: historyWorkflow,
  earlierFor: (raw) => {
    const branch = branchNamedBy(raw, HISTORY_BRANCHED);
    return branch === null ? null : earlierHistoryWorkflow(branch);
  },
};

/** Every workflow usabl writes, in the order the agreement step names them. */
export const USABL_WORKFLOWS: readonly BranchedWorkflow[] = [GATE_BRANCHED, DOCS_GATE_BRANCHED, HISTORY_BRANCHED];

/** The branch a history workflow names in its trigger, or null when it is not a plain name. */
export function historyBranchOf(raw: string): string | null {
  return branchNamedBy(raw, HISTORY_BRANCHED);
}

/**
 * The history workflow's state for `usabl doctor`, with the same rules as the gate: wired only when
 * the file is usabl's draft line for line, for the branch its trigger names, pinned to a full
 * commit SHA. The placeholder reads as unpinned, and any other change as drifted.
 */
export function classifyHistoryWorkflow(raw: string | null): GateWorkflowState {
  return classifyBranchedWorkflow(raw, 'push', historyWorkflow);
}

export async function planHistoryCi(fs: InstallFs, engineRef: string | null = null, branch = 'main'): Promise<CiPlan> {
  return planWorkflow(fs, USABL_HISTORY_WORKFLOW_PATH, historyWorkflow(branch), engineRef, earlierHistoryWorkflow(branch));
}

const HISTORY_NOTES = [
  `${USABL_HISTORY_WORKFLOW_PATH} scans the default branch after each merge and once a day, and records what it saw on the usabl/history branch, so a fixed accessibility barrier closes its slot in the accepted debt on its own.`,
  "Its history-append job needs contents: write, the one permission tracking needs. It runs no application code. To keep that write on the history branch only, add a ruleset for usabl/history that blocks force pushes and deletion. If you cannot grant the permission, leave this file out: every run then says tracking is off and keeps today's behavior.",
];

/**
 * `usabl install --ci`: the pull request gate and the default-branch history workflow. Each file is
 * planned on its own, so a hand-tuned gate does not stop the history workflow from being written,
 * and the run exits 2 when either one was refused. pin is the engine pin from this usabl's build
 * record. Both files get the same one, and with no commit both keep the placeholder. git reads the
 * app's repository, only locally; a git that cannot answer leaves every step it could have settled in.
 */
export async function installCi(fs: InstallFs, pin: EnginePin = NO_BUILD_RECORD, git: InstallGit = NO_GIT): Promise<InstallResult> {
  const engineRef = engineRefFor(pin);
  const app = await readAppOrigin(fs);
  const defaultBranch = await findDefaultBranch(git);
  const gateRaw = await fs.readFile(GATE_BRANCHED.path);
  const gateBranch = branchFor(gateRaw, GATE_BRANCHED, defaultBranch);
  const gateDraft = GATE_BRANCHED.draftFor(gateBranch);
  const gatePlan = await planWorkflow(fs, GATE_BRANCHED.path, gateDraft, engineRef, GATE_BRANCHED.earlierFor(gateRaw));
  const gate = await applyWorkflowPlan(fs, gatePlan, pin, gateDraft, 'gate workflow');
  const branch = branchFor(await fs.readFile(USABL_HISTORY_WORKFLOW_PATH), HISTORY_BRANCHED, defaultBranch);
  const historyDraft = historyWorkflow(branch);
  const history = await applyWorkflowPlan(fs, await planHistoryCi(fs, engineRef, branch), pin, historyDraft, 'history workflow');
  const branchFacts = branchReport(
    [
      { workflow: GATE_BRANCHED, branch: gateBranch, action: gate.result.action },
      { workflow: HISTORY_BRANCHED, branch, action: history.result.action },
    ],
    defaultBranch,
  );

  const setupSteps = appGateSetupSteps(app);
  setupSteps.push(...branchFacts.steps);
  const agreement = await branchAgreementStep(fs, USABL_WORKFLOWS);
  if (agreement !== null) setupSteps.push(agreement);
  // The history scan starts the app with npm run dev. Without that script it has nothing to start.
  if (history.result.action !== 'refused' && !(await hasDevScript(fs))) {
    setupSteps.push(
      `Add a "dev" script to package.json that starts your dev server. The history workflow runs "npm run dev -- --host <host> --port <port>" with the host and port of appBaseUrl, and package.json has no "dev" script. The script must start the server directly and accept --host and --port, because a script that calls another npm script does not pass them on. For example: "dev": "webpack serve --config webpack.dev.js". Or leave ${USABL_HISTORY_WORKFLOW_PATH} out: every run then says tracking is off.`,
    );
  }
  // The judge reads usabl.config.json, and usabl.routes.json when the app uses it, at the base commit
  // of each pull request. So they must be on the default branch before the pull request that adds
  // the workflows. The step is printed unless git shows the default branch already holds the same bytes.
  const judgeFiles = await presentFiles(fs, [CONFIG_PATH], [ROUTES_PATH]);
  if (!(await filesOnDefaultBranch(fs, git, judgeFiles))) {
    setupSteps.push(filesFirstStep(defaultBranch, judgeFiles, 'the workflows'));
  }
  const notes = [
    ...(gate.result.action === 'written' ? appGateNotes(app) : []),
    ...(history.result.action === 'written' ? HISTORY_NOTES : []),
    ...branchFacts.notes,
  ];
  return composeCiReport({ applied: [gate, history], pin, notes, setupSteps });
}
