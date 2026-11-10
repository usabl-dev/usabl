/**
 * The default-branch workflow `usabl install --ci` writes beside the pull request gate. It scans
 * main and records what it saw on the usabl/history branch, which is what lets a fixed barrier close
 * its slot in the accepted debt without anyone running `usabl floor prune`.
 *
 * Three jobs, so the job that runs the application never holds write access:
 * - usabl-engine builds the pinned engine, with the same job the pull request gate uses.
 * - history-scan checks out main, starts the application on the origin of appBaseUrl in main's
 *   usabl.config.json, runs `usabl history record`, and uploads the record. It runs application
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
  configOnDefaultBranch,
  findDefaultBranch,
  isSafeBranchName,
  NO_GIT,
  ROUTES_PATH,
  type DefaultBranch,
  type InstallGit,
} from './repo-git.js';
import {
  appGateNotes,
  appGateSetupSteps,
  applyWorkflowPlan,
  classifyWorkflow,
  composeCiReport,
  ENGINE_JOB,
  engineRefFor,
  planCi,
  planWorkflow,
  TRUSTED_ENGINE_STEP,
  trustedEngineSteps,
  UNPACK_ENGINE_IN_TEMP,
  USABL_GATE_WORKFLOW,
  type CiPlan,
} from './ci.js';

export const USABL_HISTORY_WORKFLOW_PATH = '.github/workflows/usabl-history.yml';

// The scan job also places the engine at ../usabl, for an app whose lockfile installs it from there.
const HISTORY_SCAN_ENGINE_UNPACK = `${UNPACK_ENGINE_IN_TEMP}
          # This places the engine in ../usabl for an app whose lockfile installs usabl from file:../usabl.
          # An app that does not use that path never reads the folder, so for that app this step does
          # not change what npm ci installs or what the build makes.
          mkdir -p "\${GITHUB_WORKSPACE}/../usabl"
          tar --extract --gzip --no-same-owner --file "\${DOWNLOAD_DIR}/usabl-engine.tgz" --directory "\${GITHUB_WORKSPACE}/../usabl"`;

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
    # A second scan of an unchanged main confirms a fix without waiting for the next merge.
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
    # Starts the application from main and scans every screen. It runs application code, so it
    # never gets write access. It writes the record to a file and nothing to git.
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
      - name: Checkout main
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
          # The scan reads appBaseUrl from this checkout of main, so the app starts on that origin,
          # never on a port this file assumes. Only an http origin on loopback with an explicit port
          # is taken, the same shape the judge needs. Anything else stops here.
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

      - name: Scan main and write the history record
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
      - name: Checkout main without running it
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

// The trigger line, as historyWorkflow writes it. A file that names its branch any other way is not
// usabl's own file.
const TRIGGER_LINE = /^ {4}branches: \["([^"]*)"\]$/;

/** The branch a history workflow names in its trigger, or null when it is not a plain name. */
export function historyBranchOf(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const match = TRIGGER_LINE.exec(line);
    if (match !== null) {
      const name = match[1] ?? '';
      return isSafeBranchName(name) ? name : null;
    }
  }
  return null;
}

// The one-based lines that hold the branch name, for the steps that say where to change it.
function branchLines(draft: string): [number, number] {
  const lines = draft.split('\n');
  return [
    lines.findIndex((line) => TRIGGER_LINE.test(line)) + 1,
    lines.findIndex((line) => line.startsWith("    if: github.ref == 'refs/heads/")) + 1,
  ];
}

/**
 * The branch the history plan uses. A file on disk that is usabl's own draft for some branch, pinned
 * or not, keeps that branch, so a re-run recognises its own file even when git now names another
 * branch or none, and a name the person put in by hand is never moved. Otherwise it is the default
 * branch git names, or main when git names none.
 */
export function historyBranchFor(raw: string | null, defaultBranch: DefaultBranch): string {
  const fallback = defaultBranch.kind === 'found' ? defaultBranch.name : 'main';
  if (raw === null) return fallback;
  const named = historyBranchOf(raw);
  if (named === null) return fallback;
  return classifyWorkflow(raw, historyWorkflow(named)) === 'drifted' ? fallback : named;
}

export async function planHistoryCi(fs: InstallFs, engineRef: string | null = null, branch = 'main'): Promise<CiPlan> {
  return planWorkflow(fs, USABL_HISTORY_WORKFLOW_PATH, historyWorkflow(branch), engineRef);
}

// What the report says about the branch the history workflow runs on: a note for the branch it
// wrote, or a step when that branch may be wrong.
function branchReport(
  action: 'written' | 'already-wired' | 'refused',
  branch: string,
  defaultBranch: DefaultBranch,
): { note?: string; step?: string } {
  if (action === 'refused') return {};
  const [trigger, scan] = branchLines(historyWorkflow(branch));
  if (defaultBranch.kind === 'found') {
    if (branch === defaultBranch.name) {
      return action === 'written' ? { note: `${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to ${branch}, the default branch git records for origin.` } : {};
    }
    return {
      step: `${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to ${branch}, but the default branch git records for origin is ${defaultBranch.name}. Put ${defaultBranch.name} in place of ${branch} on lines ${trigger} and ${scan}, or the history scan never runs.`,
    };
  }
  if (action === 'written' && branch === 'main') {
    return {
      step: `Check the branch name. usabl could not find your default branch, because ${defaultBranch.reason}. So ${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to main. If your default branch has another name, put it in place of main on lines ${trigger} and ${scan}.`,
    };
  }
  return {};
}

const HISTORY_NOTES = [
  `${USABL_HISTORY_WORKFLOW_PATH} scans the default branch after each merge and once a day, and records what it saw on the usabl/history branch, so a fixed accessibility barrier closes its slot in the accepted debt on its own.`,
  "Its history-append job needs contents: write, the one permission tracking needs. It runs no application code. To keep that write on the history branch only, add a ruleset for usabl/history that blocks force pushes and deletion. If you cannot grant the permission, leave this file out: every run then says tracking is off and keeps today's behavior.",
];

// The judge reads usabl.config.json, and usabl.routes.json when the app uses it, at the base commit
// of each pull request. So they must be on the default branch before the pull request that adds the
// workflows, or that pull request cannot pass.
function configFirstStep(branch: DefaultBranch, withRoutes: boolean): string {
  const target = branch.kind === 'found' ? branch.name : 'your default branch';
  return withRoutes
    ? `Merge ${CONFIG_PATH} and ${ROUTES_PATH} to ${target} first, in their own pull request. The judge reads them at the base commit of each pull request, so a pull request that adds them together with the workflows cannot pass.`
    : `Merge ${CONFIG_PATH} to ${target} first, in its own pull request. The judge reads it at the base commit of each pull request, so a pull request that adds it together with the workflows cannot pass.`;
}

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
  const gate = await applyWorkflowPlan(fs, await planCi(fs, engineRef), pin, USABL_GATE_WORKFLOW, 'gate workflow');
  const branch = historyBranchFor(await fs.readFile(USABL_HISTORY_WORKFLOW_PATH), defaultBranch);
  const historyDraft = historyWorkflow(branch);
  const history = await applyWorkflowPlan(fs, await planHistoryCi(fs, engineRef, branch), pin, historyDraft, 'history workflow');
  const branchFacts = branchReport(history.result.action, branch, defaultBranch);

  const setupSteps = appGateSetupSteps(app);
  if (branchFacts.step !== undefined) setupSteps.push(branchFacts.step);
  // The history scan starts the app with npm run dev. Without that script it has nothing to start.
  if (history.result.action !== 'refused' && !(await hasDevScript(fs))) {
    setupSteps.push(
      `Add a "dev" script to package.json that starts your dev server. The history workflow runs "npm run dev -- --host <host> --port <port>" with the host and port of appBaseUrl, and package.json has no "dev" script. The script must start the server directly and accept --host and --port, because a script that calls another npm script does not pass them on. For example: "dev": "webpack serve --config webpack.dev.js". Or leave ${USABL_HISTORY_WORKFLOW_PATH} out: every run then says tracking is off.`,
    );
  }
  // Printed unless git shows the default branch already holds the same config bytes.
  if (!(await configOnDefaultBranch(fs, git))) {
    setupSteps.push(configFirstStep(defaultBranch, (await fs.readFile(ROUTES_PATH)) !== null));
  }
  const notes = [
    ...(gate.result.action === 'written' ? appGateNotes(app) : []),
    ...(history.result.action === 'written' ? HISTORY_NOTES : []),
    ...(branchFacts.note === undefined ? [] : [branchFacts.note]),
  ];
  return composeCiReport({ applied: [gate, history], pin, notes, setupSteps });
}
