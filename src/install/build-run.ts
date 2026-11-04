/**
 * How the judge finds the build on a review event.
 *
 * The build runs only on pull_request. A review re-judges the same head, so the judge takes the
 * build a pull_request run made, and that run must be one made for this exact pull request:
 * another pull request can carry the same head commit and build different bytes from it, for
 * example because its build reads the pull request number or its base. So the run is bound to
 * the repository, the pull request number, the head repository, the head SHA, and the base SHA,
 * and its build-app job must have succeeded.
 *
 * GitHub leaves a run's pull_requests list empty for a pull request from a fork, so the number
 * and the base cannot be read from the run itself. The generated gate names every run with
 * run-name instead, from the event that started it, and the lookup requires that exact name. A
 * run name is computed by GitHub from the event and the workflow file, not by any step.
 */

export function gateRunName(workflowName: string): string {
  return (
    `${workflowName} \${{ github.event_name }} pr \${{ github.event.pull_request.number }}` +
    ` head \${{ github.event.pull_request.head.repo.full_name }}@\${{ github.event.pull_request.head.sha }}` +
    ` base \${{ github.event.pull_request.base.sha }}`
  );
}

// Node builtins only. Prints the run id of the newest matching pull_request run whose latest
// build-app job succeeded, or fails.
export const FIND_BUILD_RUN_SCRIPT = `'use strict';
const env = process.env;
function fail(message) {
  console.error('usabl: ' + message + '; failing closed');
  process.exit(1);
}
const want = {
  repository: env.GITHUB_REPOSITORY || '',
  workflowFile: env.WORKFLOW_FILE || '',
  workflowName: env.WORKFLOW_NAME || '',
  pr: env.PR_NUMBER || '',
  headRepository: env.HEAD_REPO || '',
  headSha: env.HEAD_SHA || '',
  baseSha: env.BASE_SHA || '',
};
const repoPattern = /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
if (!repoPattern.test(want.repository) || !repoPattern.test(want.headRepository)) fail('the repository names are not owner/name');
if (!/^[A-Za-z0-9_.-]+\\.ya?ml$/.test(want.workflowFile) || !/^[A-Za-z0-9_-]+$/.test(want.workflowName)) fail('the workflow is not named');
if (!/^[1-9][0-9]*$/.test(want.pr)) fail('the pull request number is not a number');
if (!shaPattern.test(want.headSha) || !shaPattern.test(want.baseSha)) fail('the head and base must be full commit SHAs');
let api;
try {
  api = new URL(env.GITHUB_API_URL || 'https://api.github.com');
} catch {
  fail('GITHUB_API_URL is not a URL');
}
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
if (api.protocol !== 'https:' && !(api.protocol === 'http:' && loopback)) fail('GITHUB_API_URL must be https');
if ((env.GH_TOKEN || '') === '') fail('GH_TOKEN is empty');
const base = api.href.replace(/\\/$/, '');
const workflowPath = '.github/workflows/' + want.workflowFile;
// The name the gate gave the pull_request run of this exact pull request, head, and base.
const title = want.workflowName + ' pull_request pr ' + want.pr + ' head ' + want.headRepository + '@' + want.headSha + ' base ' + want.baseSha;

async function get(path) {
  const response = await fetch(base + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'usabl',
    },
    redirect: 'error',
  });
  if (!response.ok) fail('GitHub answered ' + response.status + ' for ' + path.split('?')[0]);
  return response.json();
}

function sameRun(run) {
  if (run === null || typeof run !== 'object' || !Number.isSafeInteger(run.id)) return false;
  const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  return (
    run.event === 'pull_request' &&
    run.head_sha === want.headSha &&
    run.display_title === title &&
    (run.path === workflowPath || String(run.path).startsWith(workflowPath + '@')) &&
    run.repository !== null && typeof run.repository === 'object' && run.repository.full_name === want.repository &&
    run.head_repository !== null && typeof run.head_repository === 'object' && run.head_repository.full_name === want.headRepository &&
    // GitHub lists the pull requests only for a head in this repository. When it does, this one must be among them.
    (prs.length === 0 || prs.some((pr) => pr !== null && typeof pr === 'object' && String(pr.number) === want.pr))
  );
}

async function pages(path, key, limit) {
  const all = [];
  for (let page = 1; ; page += 1) {
    if (page > limit) fail('there are more than ' + (limit * 100) + ' ' + key + ' to search');
    const body = await get(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    const items = body !== null && typeof body === 'object' && Array.isArray(body[key]) ? body[key] : null;
    if (items === null) fail('GitHub answered without a ' + key + ' list');
    all.push(...items);
    if (items.length < 100) return all;
  }
}

async function main() {
  const runs = await pages(
    '/repos/' + want.repository + '/actions/workflows/' + encodeURIComponent(want.workflowFile) +
      '/runs?event=pull_request&status=completed&head_sha=' + want.headSha,
    'workflow_runs',
    50,
  );
  const candidates = runs.filter(sameRun).sort((a, b) => b.id - a.id);
  for (const run of candidates) {
    const jobs = await pages('/repos/' + want.repository + '/actions/runs/' + run.id + '/jobs?filter=all', 'jobs', 10);
    // The latest attempt of build-app decides: a build that failed on a re-run is not this run's build.
    const builds = jobs
      .filter((job) => job !== null && typeof job === 'object' && job.name === 'build-app')
      .sort((a, b) => (b.run_attempt || 0) - (a.run_attempt || 0) || b.id - a.id);
    const latest = builds[0];
    if (latest !== undefined && latest.status === 'completed' && latest.conclusion === 'success') {
      process.stdout.write(String(run.id) + '\\n');
      return;
    }
  }
  fail('no completed pull_request run built pull request ' + want.pr + ' at head ' + want.headSha + ' on base ' + want.baseSha);
}

main().catch((error) => fail('the lookup failed: ' + (error instanceof Error ? error.message : String(error))));`;
