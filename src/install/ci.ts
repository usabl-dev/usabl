/**
 * CI gate install generator for `usabl install --ci`.
 * It emits the two-job gate workflow that keeps fork head code away from base-repo
 * secrets. gate-comment is the only job allowed to run head code and is fenced to the
 * pull_request event; usabl-policy is the required status check that re-runs on review
 * and reads the head only as git objects. The engine SHA is a security pin the operator
 * must choose, so this draft carries a documented sentinel instead of a fabricated value.
 * Workflows are security-critical, so this writes only when absent, no-ops when identical,
 * and refuses when a hand-tuned workflow differs rather than overwrite it.
 */
import type { InstallFs, InstallResult } from './index.js';

export const USABL_GATE_WORKFLOW_PATH = '.github/workflows/usabl-gate.yml';

// usabl is not published yet, so the gate clones the engine from a private repo and pins
// it to a commit the operator trusts. We cannot know that commit, so the draft carries a
// documented sentinel the operator must replace before the gate can run. Fabricating a SHA
// would be dishonest and could pin the gate to code no one vetted.
export const ENGINE_REF_PLACEHOLDER = 'PIN_TO_A_TRUSTED_USABL_COMMIT';

// The workflow body is byte-faithful to the fixture gate, with the trusted engine ref
// replaced by the sentinel above. It is injected verbatim so every security property
// (event fencing, pinned action SHAs, persist-credentials false, the numeric PR guard,
// and the read-only snapshot) is reproduced exactly.
export const USABL_GATE_WORKFLOW = `name: usabl-gate

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

jobs:
  gate-comment:
    # The scan starts the fixture, and npm run dev executes PR head code. Only a
    # pull_request event denies secrets to fork head code, so fence the scan to it.
    # A pull_request_review event carries base-repo secrets and must never run head code.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    env:
      BASE_REF: \${{ github.event.pull_request.base.ref }}
    steps:
      - name: Checkout fixture repository
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Checkout trusted usabl engine commit
        # For now: usabl is not a published package, so clone the private repo.
        # Later: npm install usabl@0.2.0 from the registry. Drop this checkout and the token.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: PIN_TO_A_TRUSTED_USABL_COMMIT
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

      - name: Snapshot trusted engine for gate execution
        run: |
          # This part stays: the checker must not live where npm run dev can overwrite it.
          # For now the source is the git clone above. Later the source is npm install usabl.
          sudo cp -a "$GITHUB_WORKSPACE/.usabl-engine" /opt/usabl-trusted
          sudo chown -R root:root /opt/usabl-trusted
          sudo chmod -R a-w /opt/usabl-trusted
          sudo chmod -R a+rX /opt/usabl-trusted

      - name: Install fixture dependencies for CI
        run: |
          # For now the lockfile pins usabl as file:../usabl, and Actions has no sibling folder.
          # Later: npm ci installs usabl from the registry. Drop this symlink.
          # Use --ignore-scripts so PR lifecycle hooks do not run during fixture dependency installation.
          ln -sfn "$GITHUB_WORKSPACE/.usabl-engine" "$GITHUB_WORKSPACE/../usabl"
          npm ci --ignore-scripts

      - name: Start fixture on localhost
        run: |
          npm run dev -- --host 127.0.0.1 --port 5173 > /tmp/usabl-vite.log 2>&1 &
          echo "VITE_PID=$!" >> "$GITHUB_ENV"

      - name: Wait for fixture readiness
        run: |
          for _ in $(seq 1 60); do
            if curl -fsS "http://127.0.0.1:5173" > /dev/null; then
              exit 0
            fi
            sleep 1
          done
          echo "fixture did not start on 127.0.0.1:5173"
          cat /tmp/usabl-vite.log
          exit 1

      - name: Fetch trusted base ref when absent
        run: |
          if ! git rev-parse --verify --quiet "origin/\${BASE_REF}" > /dev/null; then
            git fetch origin "\${BASE_REF}" --depth=1
          fi

      - name: Run usabl check against trusted base-ref policy
        id: usabl
        run: |
          code=0
          # Keep || code=$? on the same line, because a next-line $? becomes 0 under set -e.
          # trusted-ref points to origin/\${BASE_REF} so a PR cannot rewrite policy and pass itself.
          node /opt/usabl-trusted/dist/cli.js check --ci --trusted-ref "origin/\${BASE_REF}" --json > usabl-result.json || code=$?
          echo "exit_code=\${code}" >> "$GITHUB_OUTPUT"

      - name: Stop fixture server
        if: always()
        run: |
          if [ -n "\${VITE_PID:-}" ]; then
            kill "\${VITE_PID}" || true
          fi

      - name: Validate Result JSON
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          node <<'NODE'
          const fs = require('node:fs');
          const result = JSON.parse(fs.readFileSync('usabl-result.json', 'utf8'));
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
          NODE

      - name: Render and validate comment Markdown
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          code=0
          node /opt/usabl-trusted/dist/cli.js comment < usabl-result.json > usabl-comment.md || code=$?
          if [ "\${code}" -ne "\${USABL_EXIT}" ]; then
            echo "comment renderer exit code does not match the Result exit code"
            exit 1
          fi
          if [ ! -s usabl-comment.md ]; then
            echo "comment renderer produced no markdown"
            exit 1
          fi
          node -e "const fs = require('node:fs'); const body = fs.readFileSync('usabl-comment.md', 'utf8'); if (!body.includes('<!-- usabl-report -->')) throw new Error('comment markdown has no usabl marker');"

      - name: Post sticky PR comment
        uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8
        with:
          script: |
            const fs = require('node:fs');
            const marker = '<!-- usabl-report -->';
            const body = fs.readFileSync('usabl-comment.md', 'utf8');
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

      - name: Upload Result JSON
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-result
          path: usabl-result.json
          if-no-files-found: error
          retention-days: 1

      - name: Enforce accessibility
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          if [ -z "\${USABL_EXIT}" ]; then
            echo "usabl produced no exit code; failing closed."
            exit 1
          fi
          # Never exit 2 here. Guarded-file approval lives on usabl-policy.
          node /opt/usabl-trusted/dist/cli.js enforce accessibility < usabl-result.json

  usabl-policy:
    # Required status. It re-runs on pull_request_review so a CODEOWNERS approval or
    # dismissal flips the gate. Review events carry base-repo secrets, so this job
    # must never check out or execute PR head code. It reads the head only as git
    # objects and decides from the trusted base ref, CODEOWNERS, and the reviews API.
    needs: gate-comment
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      actions: read
    env:
      BASE_REF: \${{ github.event.pull_request.base.ref }}
      HEAD_SHA: \${{ github.event.pull_request.head.sha }}
      PR_NUMBER: \${{ github.event.pull_request.number }}
    steps:
      - name: Checkout trusted base-ref policy
        # Check out the base commit, never the PR head. This working tree is trusted.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 0

      - name: Fetch base ref and head objects without checkout
        run: |
          # PR_NUMBER comes from the event as an integer. Guard it anyway before it
          # reaches a ref path, so a malformed value can never inject a fetch refspec.
          case "\${PR_NUMBER}" in
            ''|*[!0-9]*)
              echo "pull request number is not numeric; failing closed"
              exit 1
              ;;
          esac
          # Bring origin/\${BASE_REF} for the trusted-ref diff, and the PR head as
          # objects only. enforce policy reads blob contents with git show and
          # git ls-tree, which never check out or execute the head, so no PR code runs.
          git fetch --no-tags origin "+refs/heads/\${BASE_REF}:refs/remotes/origin/\${BASE_REF}"
          git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head"

      - name: Checkout trusted usabl engine commit
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: PIN_TO_A_TRUSTED_USABL_COMMIT
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

      - name: Resolve the accessibility scan run for this head
        if: github.event_name == 'pull_request_review'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          # The scan runs only on pull_request. Find its completed run for this exact
          # head SHA so the re-check consumes a real Result and never scans head code.
          # env.HEAD_SHA is read inside jq, never interpolated into the filter string.
          run_id="$(gh run list --repo "\${GITHUB_REPOSITORY}" \\
            --workflow usabl-gate.yml --event pull_request --limit 50 \\
            --json databaseId,headSha,status \\
            --jq '[.[] | select(.headSha == env.HEAD_SHA and .status == "completed")][0].databaseId')"
          if [ -z "\${run_id}" ] || [ "\${run_id}" = "null" ]; then
            echo "no completed accessibility scan for head \${HEAD_SHA}; failing closed"
            exit 1
          fi
          echo "SCAN_RUN_ID=\${run_id}" >> "$GITHUB_ENV"

      - name: Download Result JSON from this run
        if: github.event_name == 'pull_request'
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-result

      - name: Download Result JSON from the scan run
        if: github.event_name == 'pull_request_review'
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-result
          run-id: \${{ env.SCAN_RUN_ID }}
          github-token: \${{ secrets.GITHUB_TOKEN }}

      - name: Enforce policy
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          # Git refs and CODEOWNERS are the source of truth. The Result on stdin is
          # consumed only for the exit-4 crash short-circuit, never to skip owners.
          node .usabl-engine/dist/cli.js enforce policy --trusted-ref "origin/\${BASE_REF}" < usabl-result.json
`;

export const USABL_DOCS_GATE_WORKFLOW_PATH = '.github/workflows/usabl-docs-gate.yml';

// The docs gate is the sibling of the app gate for a rendered-documentation repository.
// It reproduces every fork-safety property of the app gate byte for byte: the two-job model,
// the pull_request fence on head-code execution, the pinned action SHAs, persist-credentials
// false, the numeric guard, the read-only engine snapshot, and the pull_request_review policy
// job that reads head as objects only. Only two things differ, because usabl does not serve the
// built docs itself: the gate builds the docs with an operator-supplied command and serves the
// rendered HTML on localhost, then usabl scans that origin. The build command, the built-HTML
// directory, and the serve port are repository variables, not inline edits, so this file stays
// byte-stable and the engine ref remains the only value classifyDocsGateWorkflow must reason
// about. usabl.docs.json docsBaseUrl must point at the localhost server this job starts.
export const USABL_DOCS_GATE_WORKFLOW = `name: usabl-docs-gate

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

jobs:
  gate-comment:
    # Building the docs runs PR head code, so only a pull_request event denies secrets to
    # fork head code: fence this job to it. A pull_request_review event carries base-repo
    # secrets and must never run head code.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    env:
      BASE_REF: \${{ github.event.pull_request.base.ref }}
    steps:
      - name: Checkout documentation repository
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Checkout trusted usabl engine commit
        # For now: usabl is not a published package, so clone the private repo.
        # Later: npm install usabl@0.2.1 from the registry. Drop this checkout and the token.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: PIN_TO_A_TRUSTED_USABL_COMMIT
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

      - name: Install Chromium for engine checks
        working-directory: .usabl-engine
        run: npx playwright install --with-deps chromium

      - name: Snapshot trusted engine for gate execution
        run: |
          # This part stays: the checker must not live where the docs build can overwrite it.
          # For now the source is the git clone above. Later the source is npm install usabl.
          sudo cp -a "$GITHUB_WORKSPACE/.usabl-engine" /opt/usabl-trusted
          sudo chown -R root:root /opt/usabl-trusted
          sudo chmod -R a-w /opt/usabl-trusted
          sudo chmod -R a+rX /opt/usabl-trusted

      - name: Build the documentation
        env:
          DOCS_BUILD_COMMAND: \${{ vars.USABL_DOCS_BUILD_COMMAND }}
        run: |
          # This runs PR head code (the docs build), which is why gate-comment is fenced to
          # pull_request so fork head code never sees base-repo secrets. Set the repository
          # variable USABL_DOCS_BUILD_COMMAND to your build, for example "ccutil compile".
          # ccutil is a container build, so confirm the runner can run containers.
          if [ -z "\${DOCS_BUILD_COMMAND}" ]; then
            echo "USABL_DOCS_BUILD_COMMAND repository variable is not set; failing closed."
            exit 1
          fi
          bash -c "\${DOCS_BUILD_COMMAND}"

      - name: Serve the built documentation on localhost
        env:
          BUILT_ROOT: \${{ vars.USABL_DOCS_BUILT_ROOT }}
          SERVE_PORT: \${{ vars.USABL_DOCS_SERVE_PORT }}
        run: |
          # usabl does not serve the built docs itself, so serve the rendered HTML on
          # localhost and let usabl scan that origin. usabl.docs.json docsBaseUrl must be
          # http://127.0.0.1:<USABL_DOCS_SERVE_PORT> (optionally with a path) so the scan
          # targets this server. Bind to localhost so the server is never externally reachable.
          if [ -z "\${BUILT_ROOT}" ] || [ -z "\${SERVE_PORT}" ]; then
            echo "USABL_DOCS_BUILT_ROOT and USABL_DOCS_SERVE_PORT must be set; failing closed."
            exit 1
          fi
          case "\${SERVE_PORT}" in
            ''|*[!0-9]*)
              echo "USABL_DOCS_SERVE_PORT is not numeric; failing closed."
              exit 1
              ;;
          esac
          python3 -m http.server "\${SERVE_PORT}" --bind 127.0.0.1 --directory "\${BUILT_ROOT}" > /tmp/usabl-docs-server.log 2>&1 &
          echo "DOCS_SERVER_PID=$!" >> "$GITHUB_ENV"

      - name: Wait for documentation server readiness
        env:
          SERVE_PORT: \${{ vars.USABL_DOCS_SERVE_PORT }}
        run: |
          for _ in $(seq 1 60); do
            if curl -fsS "http://127.0.0.1:\${SERVE_PORT}" > /dev/null; then
              exit 0
            fi
            sleep 1
          done
          echo "documentation server did not start on 127.0.0.1:\${SERVE_PORT}"
          cat /tmp/usabl-docs-server.log
          exit 1

      - name: Fetch trusted base ref when absent
        run: |
          if ! git rev-parse --verify --quiet "origin/\${BASE_REF}" > /dev/null; then
            git fetch origin "\${BASE_REF}" --depth=1
          fi

      - name: Run usabl check against trusted base-ref policy
        id: usabl
        run: |
          code=0
          # Keep || code=$? on the same line, because a next-line $? becomes 0 under set -e.
          # trusted-ref points to origin/\${BASE_REF} so a PR cannot rewrite policy and pass itself.
          node /opt/usabl-trusted/dist/cli.js check --ci --trusted-ref "origin/\${BASE_REF}" --json > usabl-result.json || code=$?
          echo "exit_code=\${code}" >> "$GITHUB_OUTPUT"

      - name: Stop documentation server
        if: always()
        run: |
          if [ -n "\${DOCS_SERVER_PID:-}" ]; then
            kill "\${DOCS_SERVER_PID}" || true
          fi

      - name: Validate Result JSON
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          node <<'NODE'
          const fs = require('node:fs');
          const result = JSON.parse(fs.readFileSync('usabl-result.json', 'utf8'));
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
          NODE

      - name: Render and validate comment Markdown
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          code=0
          node /opt/usabl-trusted/dist/cli.js comment < usabl-result.json > usabl-comment.md || code=$?
          if [ "\${code}" -ne "\${USABL_EXIT}" ]; then
            echo "comment renderer exit code does not match the Result exit code"
            exit 1
          fi
          if [ ! -s usabl-comment.md ]; then
            echo "comment renderer produced no markdown"
            exit 1
          fi
          node -e "const fs = require('node:fs'); const body = fs.readFileSync('usabl-comment.md', 'utf8'); if (!body.includes('<!-- usabl-report -->')) throw new Error('comment markdown has no usabl marker');"

      - name: Post sticky PR comment
        uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8
        with:
          script: |
            const fs = require('node:fs');
            const marker = '<!-- usabl-report -->';
            const body = fs.readFileSync('usabl-comment.md', 'utf8');
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

      - name: Upload Result JSON
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: usabl-result
          path: usabl-result.json
          if-no-files-found: error
          retention-days: 1

      - name: Enforce accessibility
        env:
          USABL_EXIT: \${{ steps.usabl.outputs.exit_code }}
        run: |
          if [ -z "\${USABL_EXIT}" ]; then
            echo "usabl produced no exit code; failing closed."
            exit 1
          fi
          # Never exit 2 here. Guarded-file approval lives on usabl-policy.
          node /opt/usabl-trusted/dist/cli.js enforce accessibility < usabl-result.json

  usabl-policy:
    # Required status. It re-runs on pull_request_review so a CODEOWNERS approval or
    # dismissal flips the gate. Review events carry base-repo secrets, so this job
    # must never check out or execute PR head code. It reads the head only as git
    # objects and decides from the trusted base ref, CODEOWNERS, and the reviews API.
    needs: gate-comment
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      actions: read
    env:
      BASE_REF: \${{ github.event.pull_request.base.ref }}
      HEAD_SHA: \${{ github.event.pull_request.head.sha }}
      PR_NUMBER: \${{ github.event.pull_request.number }}
    steps:
      - name: Checkout trusted base-ref policy
        # Check out the base commit, never the PR head. This working tree is trusted.
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 0

      - name: Fetch base ref and head objects without checkout
        run: |
          # PR_NUMBER comes from the event as an integer. Guard it anyway before it
          # reaches a ref path, so a malformed value can never inject a fetch refspec.
          case "\${PR_NUMBER}" in
            ''|*[!0-9]*)
              echo "pull request number is not numeric; failing closed"
              exit 1
              ;;
          esac
          # Bring origin/\${BASE_REF} for the trusted-ref diff, and the PR head as
          # objects only. enforce policy reads blob contents with git show and
          # git ls-tree, which never check out or execute the head, so no PR code runs.
          git fetch --no-tags origin "+refs/heads/\${BASE_REF}:refs/remotes/origin/\${BASE_REF}"
          git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head"

      - name: Checkout trusted usabl engine commit
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          repository: usabl-dev/usabl
          ref: PIN_TO_A_TRUSTED_USABL_COMMIT
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

      - name: Resolve the accessibility scan run for this head
        if: github.event_name == 'pull_request_review'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          # The scan runs only on pull_request. Find its completed run for this exact
          # head SHA so the re-check consumes a real Result and never scans head code.
          # env.HEAD_SHA is read inside jq, never interpolated into the filter string.
          run_id="$(gh run list --repo "\${GITHUB_REPOSITORY}" \\
            --workflow usabl-docs-gate.yml --event pull_request --limit 50 \\
            --json databaseId,headSha,status \\
            --jq '[.[] | select(.headSha == env.HEAD_SHA and .status == "completed")][0].databaseId')"
          if [ -z "\${run_id}" ] || [ "\${run_id}" = "null" ]; then
            echo "no completed accessibility scan for head \${HEAD_SHA}; failing closed"
            exit 1
          fi
          echo "SCAN_RUN_ID=\${run_id}" >> "$GITHUB_ENV"

      - name: Download Result JSON from this run
        if: github.event_name == 'pull_request'
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-result

      - name: Download Result JSON from the scan run
        if: github.event_name == 'pull_request_review'
        uses: actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e # v4.2.1
        with:
          name: usabl-result
          run-id: \${{ env.SCAN_RUN_ID }}
          github-token: \${{ secrets.GITHUB_TOKEN }}

      - name: Enforce policy
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          # Git refs and CODEOWNERS are the source of truth. The Result on stdin is
          # consumed only for the exit-4 crash short-circuit, never to skip owners.
          node .usabl-engine/dist/cli.js enforce policy --trusted-ref "origin/\${BASE_REF}" < usabl-result.json
`;

export type CiPlan =
  | { action: 'write'; path: string; contents: string }
  | { action: 'already-wired'; path: string }
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

// planCi and planDocsCi answer the same question against different targets: given the
// draft for a gate workflow and its path, may usabl write, or must it refuse? The logic is
// identical, so it lives here once and both surfaces pass their own path and draft.
async function planWorkflow(fs: InstallFs, path: string, draft: string): Promise<CiPlan> {
  const raw = await fs.readFile(path);
  if (raw === null) {
    return { action: 'write', path, contents: draft };
  }
  if (raw === draft) {
    return { action: 'already-wired', path };
  }
  // A hand-tuned gate is security-critical. We never overwrite it; we describe the gap
  // at a high level and tell the operator to reconcile by hand.
  return {
    action: 'refuse',
    path,
    difference: describeDifference(raw, draft),
  };
}

export async function planCi(fs: InstallFs): Promise<CiPlan> {
  return planWorkflow(fs, USABL_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW);
}

export async function planDocsCi(fs: InstallFs): Promise<CiPlan> {
  return planWorkflow(fs, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_DOCS_GATE_WORKFLOW);
}

function writtenReport(): string {
  return [
    `Wrote ${USABL_GATE_WORKFLOW_PATH}. Review this draft before you merge it.`,
    `Set the trusted engine ref: replace ${ENGINE_REF_PLACEHOLDER} (it appears twice) with a full 40-character commit SHA from usabl-dev/usabl that you trust.`,
    'Confirm the engine repo slug (usabl-dev/usabl) is correct and that the USABL_ENGINE_CHECKOUT_TOKEN secret exists in this repository.',
  ].join('\n');
}

function docsWrittenReport(): string {
  return [
    `Wrote ${USABL_DOCS_GATE_WORKFLOW_PATH}. Review this draft before you merge it.`,
    `Set the trusted engine ref: replace ${ENGINE_REF_PLACEHOLDER} (it appears twice) with a full 40-character commit SHA from usabl-dev/usabl that you trust.`,
    'Confirm the engine repo slug (usabl-dev/usabl) is correct and that the USABL_ENGINE_CHECKOUT_TOKEN secret exists in this repository.',
    'Set three repository variables the docs gate reads: USABL_DOCS_BUILD_COMMAND (for example "ccutil compile"), USABL_DOCS_BUILT_ROOT (the directory the build renders HTML into), and USABL_DOCS_SERVE_PORT (a free port).',
    'Point usabl.docs.json docsBaseUrl at http://127.0.0.1:<USABL_DOCS_SERVE_PORT> so the scan targets the served docs. usabl does not serve the docs itself.',
  ].join('\n');
}

// writeCi and writeDocsCi share every branch except the written-message text, so the write
// logic lives here once and each surface supplies its own report for the write case.
async function writeWorkflow(
  fs: InstallFs,
  plan: CiPlan,
  onWritten: () => string,
): Promise<InstallResult> {
  if (plan.action === 'write') {
    await fs.writeFile(plan.path, plan.contents);
    return { exitCode: 0, action: 'written', path: plan.path, message: onWritten() };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: plan.path,
      message: `${plan.path} already matches the usabl gate workflow. No change.`,
    };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: `Refusing to overwrite ${plan.path}: it differs from the usabl draft, and ${plan.difference}. Reconcile it by hand; usabl never overwrites a hand-tuned security workflow.`,
  };
}

export async function writeCi(fs: InstallFs, plan: CiPlan): Promise<InstallResult> {
  return writeWorkflow(fs, plan, writtenReport);
}

export async function writeDocsCi(fs: InstallFs, plan: CiPlan): Promise<InstallResult> {
  return writeWorkflow(fs, plan, docsWrittenReport);
}

// A pin-aware recognizer for `usabl doctor`, additive to the install plan above and next to
// the constants it needs. planCi answers a different question: "may usabl write, or must it
// refuse?", so it treats the draft (sentinel and all) as the one shape it may no-op on and
// anything else as a hand-tuned file to leave alone. doctor asks "is this surface
// functionally correct?", and the honest answer turns on the engine ref. The draft ships
// unpinned (the sentinel), a correctly wired workflow carries a real commit SHA at both
// engine-ref lines, and any other change is drift. classifyGateWorkflow reports those states
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

// The recognizer is draft-relative: it compares the on-disk file against a specific draft,
// so the app gate and the docs gate share one implementation and each passes its own draft.
function classifyWorkflow(raw: string | null, draft: string): GateWorkflowState {
  // Recognition never fails toward success. Only a workflow that matches the draft line for
  // line, differing solely at the engine-ref lines and only to the same real 40-character
  // commit SHA, reads as wired. Everything less confident lands on missing, unpinned, or
  // drifted, never wired.
  if (raw === null) {
    return 'missing';
  }
  const actualLines = raw.split('\n');
  const draftLines = draft.split('\n');
  // A different line count is a structural change, never just a pin: drifted.
  if (actualLines.length !== draftLines.length) {
    return 'drifted';
  }
  const refValues: string[] = [];
  for (let i = 0; i < draftLines.length; i += 1) {
    const draftLine = draftLines[i] ?? '';
    const actualLine = actualLines[i] ?? '';
    const indent = draftEngineRefIndent(draftLine);
    if (indent === null) {
      // A fixed line. It is correct only when it matches the draft exactly.
      if (draftLine !== actualLine) {
        return 'drifted';
      }
      continue;
    }
    // An engine-ref line. The pin value is variable, but the line must still be a ref line at
    // the same indent. Anything else here is a structural edit, not a pin: drifted.
    const actualMatch = /^(\s*)ref:\s*(\S+)\s*$/.exec(actualLine);
    if (actualMatch === null || actualMatch[1] !== indent) {
      return 'drifted';
    }
    refValues.push(actualMatch[2] ?? '');
  }
  // The draft always carries exactly two engine-ref lines. If none matched, the draft itself
  // changed shape underneath us; treat that as drifted rather than guess.
  if (refValues.length === 0) {
    return 'drifted';
  }
  const first = refValues[0] ?? '';
  const allSame = refValues.every((value) => value === first);
  if (!allSame) {
    // The engine-ref lines disagree, for example one pinned and one still the sentinel. That
    // is an inconsistent pin, not a confident wired.
    return 'drifted';
  }
  if (/^[0-9a-f]{40}$/.test(first)) {
    return 'wired';
  }
  if (first === ENGINE_REF_PLACEHOLDER) {
    return 'unpinned';
  }
  // A single consistent ref that is neither a full commit SHA nor the sentinel: a branch, a
  // tag, or a short SHA. usabl cannot confirm that as a trusted pin, so: drifted.
  return 'drifted';
}

export function classifyGateWorkflow(raw: string | null): GateWorkflowState {
  return classifyWorkflow(raw, USABL_GATE_WORKFLOW);
}

export function classifyDocsGateWorkflow(raw: string | null): GateWorkflowState {
  return classifyWorkflow(raw, USABL_DOCS_GATE_WORKFLOW);
}
