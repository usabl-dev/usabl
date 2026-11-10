/**
 * The one way every workflow usabl writes takes the app's default branch. The gate, the docs gate,
 * and the history workflow each name that branch in their trigger, and nothing else in them varies
 * with it. The branch comes from the clone's origin/HEAD, only as a plain name, and is written
 * quoted. When git cannot name one, the file names main and the report prints a step to check it.
 * A branch already in usabl's own file is kept on a re-run, so after install the file on disk is
 * the source of truth for which branch the workflow runs on.
 */
import type { InstallFs } from './index.js';
import {
  classifyBranchedWorkflow,
  classifyWorkflow,
  docsGateWorkflowFor,
  EARLIER_DOCS_GATE_WORKFLOW,
  EARLIER_GATE_WORKFLOW,
  gateWorkflowFor,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW_PATH,
} from './ci.js';
import { workflowTriggerBranch, type DefaultBranch } from './repo-git.js';

/** A workflow whose draft names one branch in its trigger. */
export interface BranchedWorkflow {
  path: string;
  // The trigger event whose branch filter carries the name.
  event: 'pull_request' | 'push';
  // How the report says when the workflow runs, before the branch name.
  runsOn: string;
  // What goes wrong when the branch is not the default branch, for the step that says so.
  ifWrong: string;
  draftFor(branch: string): string;
  // The placeholder draft an earlier 0.3.0 build wrote that this file would be checked against, or
  // null when there is none.
  earlierFor(raw: string | null): string | null;
}

export const GATE_BRANCHED: BranchedWorkflow = {
  path: USABL_GATE_WORKFLOW_PATH,
  event: 'pull_request',
  runsOn: 'runs on pull requests into',
  ifWrong: 'the gate never runs and "usabl-required" never reports',
  draftFor: gateWorkflowFor,
  earlierFor: () => EARLIER_GATE_WORKFLOW,
};

export const DOCS_GATE_BRANCHED: BranchedWorkflow = {
  path: USABL_DOCS_GATE_WORKFLOW_PATH,
  event: 'pull_request',
  runsOn: 'runs on pull requests into',
  ifWrong: 'the docs gate never runs and "usabl-required" never reports',
  draftFor: docsGateWorkflowFor,
  earlierFor: () => EARLIER_DOCS_GATE_WORKFLOW,
};

/** The branch a workflow file names in its trigger, or null when it names none usabl can read. */
export function branchNamedBy(raw: string | null, workflow: BranchedWorkflow): string | null {
  return workflowTriggerBranch(raw, workflow.event);
}

/** Whether the file on disk is the unedited draft an earlier 0.3.0 build wrote, pinned or not. */
export function isEarlierDraft(raw: string | null, workflow: BranchedWorkflow): boolean {
  const earlier = workflow.earlierFor(raw);
  return raw !== null && earlier !== null && classifyWorkflow(raw, earlier) !== 'drifted';
}

/**
 * The branch the plan for one workflow uses. A file on disk that is usabl's own draft for some
 * branch, pinned or not, keeps that branch, so a re-run recognises its own file even when git now
 * names another branch or none, and a name the person put in by hand is never moved. An earlier
 * 0.3.0 draft keeps the branch it names in the quoted form; an earlier gate, which could only name
 * main, takes the default branch. Otherwise it is the default branch git names, or main when git
 * names none.
 */
export function branchFor(raw: string | null, workflow: BranchedWorkflow, defaultBranch: DefaultBranch): string {
  const fallback = defaultBranch.kind === 'found' ? defaultBranch.name : 'main';
  if (isEarlierDraft(raw, workflow)) return branchNamedBy(raw, workflow) ?? fallback;
  if (classifyBranchedWorkflow(raw, workflow.event, workflow.draftFor) === 'drifted') return fallback;
  return branchNamedBy(raw, workflow) ?? fallback;
}

/** The one-based lines of the draft that carry the branch name, for the steps that say where to change it. */
export function branchLines(workflow: BranchedWorkflow, branch: string): number[] {
  const probe = branch === 'x' ? 'y' : 'x';
  const other = workflow.draftFor(probe).split('\n');
  return workflow
    .draftFor(branch)
    .split('\n')
    .flatMap((line, index) => (line === other[index] ? [] : [index + 1]));
}

// "a", "a and b", "a, b, and c". clauses puts a comma before "and" even for two, for full clauses.
function joinList(items: readonly string[], clauses = false): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2 && !clauses) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function linesText(lines: readonly number[]): string {
  return `${lines.length === 1 ? 'line' : 'lines'} ${joinList(lines.map(String))}`;
}

/** One workflow after its plan was applied, for the branch report. */
export interface BranchOutcome {
  workflow: BranchedWorkflow;
  branch: string;
  action: 'written' | 'already-wired' | 'refused';
}

/**
 * What the report says about the branch each workflow runs on: a note for a branch written that
 * matches the default branch git records, a step for a file that names another branch, and one step
 * for every file written with main because git could not name a branch. A refused file is left out:
 * its own refusal is the step.
 */
export function branchReport(outcomes: readonly BranchOutcome[], defaultBranch: DefaultBranch): { notes: string[]; steps: string[] } {
  const notes: string[] = [];
  const steps: string[] = [];
  const considered = outcomes.filter((outcome) => outcome.action !== 'refused');
  if (defaultBranch.kind === 'found') {
    const target = defaultBranch.name;
    for (const { workflow, branch, action } of considered) {
      if (branch === target) {
        if (action === 'written') notes.push(`${workflow.path} ${workflow.runsOn} ${branch}, the default branch git records for origin.`);
        continue;
      }
      steps.push(
        `${workflow.path} ${workflow.runsOn} ${branch}, but the default branch git records for origin is ${target}. Put ${target} in place of ${branch} on ${linesText(branchLines(workflow, branch))}, or ${workflow.ifWrong}.`,
      );
    }
    return { notes, steps };
  }
  const guessed = considered.filter((outcome) => outcome.action === 'written' && outcome.branch === 'main');
  if (guessed.length > 0) {
    const runs = joinList(
      guessed.map(({ workflow }) => `${workflow.path} ${workflow.runsOn} main`),
      true,
    );
    const where = joinList(guessed.map(({ workflow }) => `${linesText(branchLines(workflow, 'main'))} of ${workflow.path}`));
    steps.push(
      `Check the branch name. usabl could not find your default branch, because ${defaultBranch.reason}. So ${runs}. If your default branch has another name, put it in place of main on ${where}.`,
    );
  }
  return { notes, steps };
}

/**
 * The step printed when the usabl workflows on disk name different branches, or null when they
 * agree. Each file present is read for the branch its trigger names; a file whose trigger usabl
 * cannot read is left out. usabl does not rewrite a file to make them agree.
 */
export async function branchAgreementStep(fs: InstallFs, workflows: readonly BranchedWorkflow[]): Promise<string | null> {
  const named: Array<{ path: string; branch: string }> = [];
  for (const workflow of workflows) {
    const branch = branchNamedBy(await fs.readFile(workflow.path), workflow);
    if (branch !== null) named.push({ path: workflow.path, branch });
  }
  if (new Set(named.map((entry) => entry.branch)).size <= 1) return null;
  const each = joinList(
    named.map((entry) => `${entry.path} names ${entry.branch}`),
    true,
  );
  return `The usabl workflows name different branches: ${each}. Each one must name your default branch, or one of them runs on the wrong branch. usabl does not change a file to make them agree. Edit the branch name in each file that is wrong, then run this command again.`;
}

/**
 * The step that says to merge the files the judge reads at the base commit to the default branch
 * first. The judge reads them at the base commit of each pull request, so a pull request that adds
 * them together with the workflows cannot pass.
 */
export function filesFirstStep(defaultBranch: DefaultBranch, files: readonly string[], workflows: 'the workflows' | 'the workflow'): string {
  const target = defaultBranch.kind === 'found' ? defaultBranch.name : 'your default branch';
  const one = files.length === 1;
  return `Merge ${joinList(files)} to ${target} first, in ${one ? 'its' : 'their'} own pull request. The judge reads ${one ? 'it' : 'them'} at the base commit of each pull request, so a pull request that adds ${one ? 'it' : 'them'} together with ${workflows} cannot pass.`;
}
