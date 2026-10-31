/**
 * The default-branch workflow `usabl install --ci` writes beside the pull request gate. It scans
 * main and records what it saw on the usabl/history branch, which is what lets a fixed barrier close
 * its slot in the accepted debt without anyone running `usabl floor prune`.
 *
 * Two jobs, so the job that runs the application never holds write access:
 * - history-scan checks out main, starts the application, runs `usabl history record`, and uploads
 *   the record. It runs application code, so it reads only.
 * - history-append downloads the record, adds it to the history branch with `usabl history append`,
 *   and pushes without force. It runs only the trusted engine, so it is the one job that writes. It
 *   needs `contents: write`, the one permission tracking needs. GitHub cannot narrow that to one
 *   branch; a ruleset on usabl/history can.
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
import { ENGINE_REF_PLACEHOLDER, planCi, writeCi, type CiPlan } from './ci.js';

export const USABL_HISTORY_WORKFLOW_PATH = '.github/workflows/usabl-history.yml';

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

jobs:
  history-scan:
    # Starts the application from main and scans every screen. It runs application code, so it
    # never gets write access. It writes the record to a file and nothing to git.
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout main
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Checkout trusted usabl engine commit
        # For now: usabl is not a published package, so clone the private repo.
        # Later: npm install usabl from the registry. Drop this checkout and the token.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: ${ENGINE_REF_PLACEHOLDER}
          path: .usabl-engine
          token: \${{ secrets.USABL_ENGINE_CHECKOUT_TOKEN }}
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: |
            package-lock.json
            .usabl-engine/package-lock.json

      - name: Install and build trusted engine
        working-directory: .usabl-engine
        run: npm ci && npm run build

      - name: Install Chromium for engine checks
        working-directory: .usabl-engine
        run: npx playwright install --with-deps chromium

      - name: Snapshot trusted engine for the scan
        run: |
          # The checker must not live where npm run dev can overwrite it.
          sudo cp -a "$GITHUB_WORKSPACE/.usabl-engine" /opt/usabl-trusted
          sudo chown -R root:root /opt/usabl-trusted
          sudo chmod -R a-w /opt/usabl-trusted
          sudo chmod -R a+rX /opt/usabl-trusted

      - name: Install application dependencies
        run: |
          # For now the lockfile pins usabl as file:../usabl, and Actions has no sibling folder.
          # Later: npm ci installs usabl from the registry. Drop this symlink.
          ln -sfn "$GITHUB_WORKSPACE/.usabl-engine" "$GITHUB_WORKSPACE/../usabl"
          npm ci --ignore-scripts

      - name: Start application on localhost
        run: |
          npm run dev -- --host 127.0.0.1 --port 5173 > /tmp/usabl-vite.log 2>&1 &
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
          cat /tmp/usabl-vite.log
          exit 1

      - name: Scan main and write the history record
        run: node /opt/usabl-trusted/dist/cli.js history record --out usabl-history-record.json

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
    # Adds the record to the usabl/history branch. It runs no application code, only the trusted
    # engine, so it is the one job that may write. Pushes never force, so a record is never lost.
    needs: history-scan
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout main without running it
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          fetch-depth: 0

      - name: Checkout trusted usabl engine commit
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: ${ENGINE_REF_PLACEHOLDER}
          path: .usabl-engine
          token: \${{ secrets.USABL_ENGINE_CHECKOUT_TOKEN }}
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: .usabl-engine/package-lock.json

      - name: Install and build trusted engine
        working-directory: .usabl-engine
        run: npm ci && npm run build

      - name: Download the history record
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-history-record

      - name: Append the record and push the history branch
        run: |
          # Fetch the branch fresh on every try, append on top of it, and push without force. A
          # push that loses a race is refused, so the loop fetches the newer branch and tries again.
          for attempt in 1 2 3; do
            git fetch --no-tags origin "+refs/heads/usabl/history:refs/remotes/origin/usabl/history" || echo "no usabl/history branch yet; the first record starts it"
            node .usabl-engine/dist/cli.js history append usabl-history-record.json
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
    `It scans main after each merge and once a day, and records what it saw on the usabl/history branch, so a fixed barrier closes its slot in the accepted debt on its own. Replace ${ENGINE_REF_PLACEHOLDER} (it appears twice) with the same commit SHA you pin in the gate.`,
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
