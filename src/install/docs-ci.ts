/**
 * `usabl install --docs-ci`: the docs gate, on pull requests into the default branch git names,
 * taken the same way as the app gate and the history workflow. The docs judge reads
 * usabl.config.json and usabl.docs.json at the base commit of each pull request (and
 * usabl.routes.json when the repository has one), so they must be on the default branch before the
 * pull request that adds the workflow. The report says so unless git shows the same bytes there.
 */
import type { InstallFs, InstallResult } from './index.js';
import { NO_BUILD_RECORD, type EnginePin } from './build-info.js';
import { CONFIG_PATH } from './app-origin.js';
import { DOCS_MANIFEST_PATH } from '../init/docs/index.js';
import {
  applyWorkflowPlan,
  composeCiReport,
  DOCS_GATE_NOTES,
  DOCS_GATE_SETUP_STEPS,
  engineRefFor,
  planWorkflow,
} from './ci.js';
import { filesOnDefaultBranch, findDefaultBranch, NO_GIT, presentFiles, ROUTES_PATH, type InstallGit } from './repo-git.js';
import { branchAgreementStep, branchFor, branchReport, DOCS_GATE_BRANCHED, filesFirstStep } from './workflow-branch.js';
import { USABL_WORKFLOWS } from './history-ci.js';

export async function installDocsCi(fs: InstallFs, pin: EnginePin = NO_BUILD_RECORD, git: InstallGit = NO_GIT): Promise<InstallResult> {
  const defaultBranch = await findDefaultBranch(git);
  const branch = branchFor(await fs.readFile(DOCS_GATE_BRANCHED.path), DOCS_GATE_BRANCHED, defaultBranch);
  const draft = DOCS_GATE_BRANCHED.draftFor(branch);
  const docsGate = await applyWorkflowPlan(
    fs,
    await planWorkflow(fs, DOCS_GATE_BRANCHED.path, draft, engineRefFor(pin)),
    pin,
    draft,
    'docs gate workflow',
  );
  const branchFacts = branchReport([{ workflow: DOCS_GATE_BRANCHED, branch, action: docsGate.result.action }], defaultBranch);

  const setupSteps = [...DOCS_GATE_SETUP_STEPS, ...branchFacts.steps];
  const agreement = await branchAgreementStep(fs, USABL_WORKFLOWS);
  if (agreement !== null) setupSteps.push(agreement);
  const judgeFiles = await presentFiles(fs, [CONFIG_PATH, DOCS_MANIFEST_PATH], [ROUTES_PATH]);
  if (!(await filesOnDefaultBranch(fs, git, judgeFiles))) {
    setupSteps.push(filesFirstStep(defaultBranch, judgeFiles, 'the workflow'));
  }
  return composeCiReport({ applied: [docsGate], pin, notes: [...DOCS_GATE_NOTES, ...branchFacts.notes], setupSteps });
}
