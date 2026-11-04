/**
 * The default-branch workflow `usabl install --ci` writes beside the pull request gate. It scans
 * main and records what it saw on the usabl/history branch, which is what lets a fixed barrier close
 * its slot in the accepted debt without anyone running `usabl floor prune`.
 *
 * Three jobs, so the job that runs the application never holds write access:
 * - usabl-engine builds the pinned engine, with the same job the pull request gate uses.
 * - history-scan checks out main, starts the application, runs `usabl history record`, and uploads
 *   the record. It runs application code, so it reads only.
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
import {
  ENGINE_JOB,
  ENGINE_REF_PLACEHOLDER,
  planCi,
  TRUSTED_ENGINE_STEP,
  trustedEngineSteps,
  UNPACK_ENGINE_IN_TEMP,
  writeCi,
  type CiPlan,
} from './ci.js';

export const USABL_HISTORY_WORKFLOW_PATH = '.github/workflows/usabl-history.yml';

// The scan job also places the engine where the application's lockfile expects it.
const HISTORY_SCAN_ENGINE_UNPACK = `${UNPACK_ENGINE_IN_TEMP}
          # For now the lockfile pins usabl as file:../usabl, and Actions has no sibling folder.
          # Later: npm ci installs usabl from the registry. Drop these two lines.
          mkdir "\${GITHUB_WORKSPACE}/../usabl"
          tar --extract --gzip --no-same-owner --file "\${DOWNLOAD_DIR}/usabl-engine.tgz" --directory "\${GITHUB_WORKSPACE}/../usabl"`;

export const USABL_HISTORY_WORKFLOW = `name: usabl-history

on:
  push:
    branches: [main]
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
    if: github.ref == 'refs/heads/main'
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

      - name: Start application on localhost
        run: |
          npm run dev -- --host 127.0.0.1 --port 5173 > "\${RUNNER_TEMP}/usabl-vite.log" 2>&1 &
          echo "VITE_PID=$!" >> "$GITHUB_ENV"

      - name: Wait for application readiness
        run: |
          for _ in $(seq 1 60); do
            if curl -fsS "http://127.0.0.1:5173" > /dev/null; then
              exit 0
            fi
            sleep 1
          done
          echo "application did not start on 127.0.0.1:5173"
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

export async function planHistoryCi(fs: InstallFs): Promise<CiPlan> {
  const raw = await fs.readFile(USABL_HISTORY_WORKFLOW_PATH);
  if (raw === null) return { action: 'write', path: USABL_HISTORY_WORKFLOW_PATH, contents: USABL_HISTORY_WORKFLOW };
  if (raw === USABL_HISTORY_WORKFLOW) return { action: 'already-wired', path: USABL_HISTORY_WORKFLOW_PATH };
  return {
    action: 'refuse',
    path: USABL_HISTORY_WORKFLOW_PATH,
    difference: 'it differs from the usabl draft',
  };
}

function historyWrittenReport(): string {
  return [
    `Wrote ${USABL_HISTORY_WORKFLOW_PATH}. Review this draft before you merge it.`,
    `It scans main after each merge and once a day, and records what it saw on the usabl/history branch, so a fixed barrier closes its slot in the accepted debt on its own. Replace ${ENGINE_REF_PLACEHOLDER} (it appears once, in the usabl-engine job) with the same commit SHA you pin in the gate.`,
    'Its history-append job needs contents: write, the one permission tracking needs. It runs no application code. To keep that write on the history branch only, add a ruleset for usabl/history that blocks force pushes and deletion. If you cannot grant the permission, leave this file out: every run then says tracking is off and keeps today\'s behavior.',
  ].join('\n');
}

async function writeHistoryCi(fs: InstallFs, plan: CiPlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    await fs.writeFile(plan.path, plan.contents);
    return { exitCode: 0, action: 'written', path: plan.path, message: historyWrittenReport() };
  }
  if (plan.action === 'already-wired') {
    return { exitCode: 0, action: 'already-wired', path: plan.path, message: `${plan.path} already matches the usabl history workflow. No change.` };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: `Refusing to overwrite ${plan.path}: ${plan.difference}. Reconcile it by hand; usabl never overwrites a hand-tuned workflow.`,
  };
}

/**
 * `usabl install --ci`: the pull request gate and the default-branch history workflow. Each file is
 * planned on its own, so a hand-tuned gate does not stop the history workflow from being written,
 * and the run exits 2 when either one was refused.
 */
export async function installCi(fs: InstallFs): Promise<InstallResult> {
  const gate = await writeCi(fs, await planCi(fs));
  const history = await writeHistoryCi(fs, await planHistoryCi(fs));
  const refused = gate.exitCode !== 0 || history.exitCode !== 0;
  return {
    exitCode: refused ? 2 : 0,
    action: gate.action === 'refused' || history.action === 'refused' ? 'refused' : gate.action === 'written' || history.action === 'written' ? 'written' : 'already-wired',
    path: gate.path,
    message: `${gate.message}\n\n${history.message}`,
  };
}
