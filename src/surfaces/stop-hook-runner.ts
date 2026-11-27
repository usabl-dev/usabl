#!/usr/bin/env node
/**
 * Stop-hook runner for Claude Code and Cursor protocol integration.
 * This unit projects existing trust signals and prints protocol output only.
 * It must never block via exit code or mint a verdict outside the gate.
 *
 * Two output protocols:
 *   Claude Code (default): {"decision":"block","reason":"..."} on stdout to block.
 *   Cursor (--cursor):     {"followup_message":"..."} on stdout to loop the agent,
 *                          {} to allow it to finish. Cursor's stop event receives
 *                          {"status":"...","loop_count":N} on stdin; loop_count > 0
 *                          maps to stopHookActive to prevent recursive loops.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Deps, Result, UsablConfig } from '../contracts/index.js';
import { buildDeps } from '../deps/build.js';
import { makeGitReader, NO_HEAD_MESSAGE } from '../deps/git.js';
import { gitProcessEnvironment } from '../deps/git-environment.js';
import { EMPTY_SUBMODULES_NAME, SPARSE_STATE_NAME } from '../deps/worktree.js';
import { receiptFailureReasons, verifyReceipt } from '../evidence/receipt.js';
import { run, type RunOptions } from '../run.js';
import { checkGuard, computeSessionPins, diffSessionPins, pinsAreCurrent, type SessionPins } from '../trust/guard.js';
import { parseConfigText } from '../intake/load-config.js';
import { emptyUiFileGlobsRefusal, uiFileGlobsRefusal } from '../intake/ui-file-globs.js';
import { assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import { APPROVAL_REQUIRED_HOW_IT_CLEARS, APPROVAL_REQUIRED_HUMAN_LEVER, guardedFilesHeadline } from '../output/disclosure.js';
import { firstLine } from '../primitives/first-line.js';
import { GUARDED_FILES_LABEL } from './model-pieces.js';
import {
  checkCommandFor,
  findStartingCommit,
  NO_TRUSTED_BRANCH_NOTE,
  olderThanSetupLines,
  resolveBranchScope,
  scopeGapHeadline,
  scopeGapDetailPiece,
  scopeGapNextStep,
  scopeGit,
  type BranchScope,
  type CheckCommand,
  type StartingCommit,
} from './stop-hook-scope.js';
import { frameUntrustedBlock } from './scrub.js';
import {
  ANSWER_FINISH_WAIT_MS,
  BROWSER_CLOSE_WAIT_MS,
  afterDeadlineWaitMs,
  STOP_HOOK_TIMEOUT_ENV,
  deadlineMessage,
  hostLimit,
  runnerDeadlineSeconds,
  type StopHookDeadlinePort,
  type StopTimer,
} from './stop-hook-deadline.js';
import {
  evaluateStopDecision,
  formatStoredReceiptAllow,
  type HookContext,
  type StoredReceiptPinState,
} from './stop-hook.js';
import { BYPASS_ONCE_PATH, loadReceipt, makeReceiptFs, receiptToSave, saveReceipt, type ReceiptFs } from './receipt-store.js';
import { noReceiptMessage, receiptConfigCheck } from '../evidence/planned-config.js';
import {
  currentUid,
  deletePinFileFix,
  makeFsSessionPinStore,
  resolveSessionPinDir,
  type SessionPinStore,
} from './session-pin-store.js';

export interface StopHookInput {
  stopHookActive: boolean;
  sessionId: string | null;
}

export interface StopHookRunnerFs extends ReceiptFs {
  unlink(path: string): Promise<void>;
}

/**
 * What a read of one file found: its text, nothing at the path, or an error that stopped the read.
 * A read of the working config also keeps the raw bytes the text was decoded from, so the receipt
 * check compares and hashes the file as it is on disk. Without them, the text encoded as UTF-8
 * stands in.
 */
export type FileBytes =
  | { status: 'found'; text: string; bytes?: Uint8Array }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

/**
 * What the hook found at the last commit. `no-work-tree` means the hook found no git work tree from
 * the folder it started in, so it could not look at a last commit at all.
 */
export type HeadBytes = FileBytes | { status: 'no-work-tree' };

/** usabl.config.json as the working tree holds it and as the last commit holds it, as raw bytes. */
export interface ConfigBytes {
  working: FileBytes;
  head: HeadBytes;
}

export interface StopHookRunnerPorts {
  // Paths are relative to the repository root, so the receipt and the bypass file are the
  // repository's own wherever the assistant changed directory to.
  fs: StopHookRunnerFs;
  // Where session pins are kept. The real one is private to the user; see session-pin-store.ts.
  pins: SessionPinStore;
  // The repository root the hook works in. It keys the session pins.
  cwd: () => string;
  stdoutWrite: (text: string) => Promise<void> | void;
  stderrWrite: (text: string) => Promise<void> | void;
  // usabl.config.json at the repository root and at HEAD, read before anything parses it.
  readConfigBytes: () => Promise<ConfigBytes>;
  // Parses the config bytes readConfigBytes returned. It never reads the file again.
  loadConfig: (text: string) => Promise<UsablConfig>;
  buildDeps: (config: UsablConfig) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig, opts?: RunOptions) => Promise<Result>;
  // The commit where this branch left the trusted branch. See stop-hook-scope.ts. The real ports
  // always set it. Absent only in ports a test builds by hand: the stop then checks the changes
  // that are not committed, as it did before this was built.
  findStartingCommit?: () => Promise<StartingCommit>;
  evaluateDecision: (result: Result, ctx: HookContext, config?: UsablConfig) => { block: boolean; message: string };
  // The hook's own deadline. See stop-hook-deadline.ts. The stop-hook command always sets it.
  // Absent in ports a test builds: the stop then runs with no deadline, as it did before.
  deadline?: StopHookDeadlinePort;
  // True when CLAUDE_PROJECT_DIR named a folder outside any work tree and the hook used the work
  // tree of its own folder instead, which follows the assistant. Every decision then says which
  // repository it checked. See hookRepository and ownRepositoryNote.
  repositoryFromOwnFolder?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStopHookInput(raw: unknown): StopHookInput {
  if (!isRecord(raw)) {
    return { stopHookActive: false, sessionId: null };
  }
  const stopHookActive = raw['stop_hook_active'] === true;
  const sessionIdRaw = raw['session_id'];
  const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;
  return { stopHookActive, sessionId };
}

function isSessionPins(value: unknown): value is SessionPins {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Pin file name for one session in one repository, inside the user's pin directory.
 *
 * The key includes the repository because the hook runs in the session's current working
 * directory, and that directory moves when the assistant changes directories. A session
 * that stops in a demo app and then in a second app would otherwise compare the second
 * app's guarded digests against pins written from the first, and report guarded policy
 * drift that never happened. The repository key is the first 16 hex characters of the
 * SHA-256 of the resolved repository root. The hook finds that root from the folder it starts in
 * and loads the config there, so a stop in a subfolder keys the same pins as one at the root.
 *
 * The user is bound by the directory, which only that user can use: see resolveSessionPinDir
 * in session-pin-store.ts.
 *
 * Pure: it derives a name and touches no filesystem.
 */
export function sessionPinFileName(sessionId: string, cwd: string): string {
  const repoKey = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return `${sessionId}-${repoKey}.json`;
}

// What to change when the hook input carried no session id usabl can use. Fixed text.
const SESSION_ID_FIX =
  'run the hook from an assistant that sends a session id in its Stop hook input ' +
  '(Claude Code sends session_id, Cursor sends conversation_id). Each stop goes without the drift ' +
  'comparison until then.';

// A session id usabl can key pins by, or the notice that says why it could not. The id the input
// carried is a value someone else wrote, so the notice prints it only inside the frame.
function parseSessionId(raw: string | null): { sessionId: string } | { notice: PinNotice } {
  if (raw === null) {
    return { notice: pinsNotUsed('the hook input carried no session id', SESSION_ID_FIX) };
  }
  const candidate = raw.trim();
  const safePattern = /^[A-Za-z0-9._-]{1,128}$/;
  if (!safePattern.test(candidate) || candidate.includes('..')) {
    return {
      notice: pinsNotUsed('the session id in the hook input is not one usabl can use as a file name', SESSION_ID_FIX, [
        `session_id: ${JSON.stringify(raw)}`,
      ]),
    };
  }
  return { sessionId: candidate };
}

/**
 * Fixed lines, then the carried values inside one untrusted frame. Paths, ids, and error text in
 * this file come from the repository, the hook input, the environment, or a thrown error, so none
 * of them is printed as usabl's own words. Each piece is bounded and scrubbed by the frame.
 */
function framedMessage(lines: string[], pieces: string[]): string {
  if (pieces.length === 0) {
    return lines.join('\n');
  }
  return assembleBoundedMessage({
    scaffold: lines,
    keep: lines.length,
    pieces: pieces.map((piece) => boundField(piece, 'gapReason')),
    keepPieces: pieces.length,
    frame: frameUntrustedBlock,
  });
}

async function writeStderr(ports: StopHookRunnerPorts, text: string): Promise<void> {
  await ports.stderrWrite(text.endsWith('\n') ? text : `${text}\n`);
}

// Cursor stdin carries loop_count so we can detect re-entry. Claude stdin carries
// stop_hook_active as a boolean. This parser reads both shapes into the shared input type.
function parseCursorStopInput(raw: unknown): StopHookInput {
  if (!isRecord(raw)) {
    return { stopHookActive: false, sessionId: null };
  }
  // Cursor sends loop_count as an integer. Values above 0 mean the agent already looped,
  // which maps to stopHookActive to prevent recursive block-loop cycles.
  const loopCount = raw['loop_count'];
  const stopHookActive = typeof loopCount === 'number' && loopCount > 0;
  // Cursor does not send session_id today. If it does later, the same parse applies.
  const sessionIdRaw = raw['conversation_id'] ?? raw['session_id'];
  const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;
  return { stopHookActive, sessionId };
}

async function emitBlock(ports: StopHookRunnerPorts, reason: string): Promise<void> {
  // Claude Code only blocks when stdout receives a decision object, so exit codes stay non-blocking.
  await ports.stdoutWrite(JSON.stringify({ decision: 'block', reason }) + '\n');
}

async function emitCursorBlock(ports: StopHookRunnerPorts, reason: string): Promise<void> {
  // Cursor's stop hook loops the agent by receiving a followup_message. The message becomes
  // additional context for the agent's next turn, telling it what failed and why.
  await ports.stdoutWrite(JSON.stringify({ followup_message: reason }) + '\n');
}

async function emitCursorAllow(ports: StopHookRunnerPorts): Promise<void> {
  // An empty object lets the agent finish. Cursor requires valid JSON on stdout.
  await ports.stdoutWrite('{}\n');
}

async function consumeBypassOnce(fs: StopHookRunnerFs): Promise<boolean> {
  const bypass = await fs.readFile(BYPASS_ONCE_PATH);
  if (bypass === null) {
    return false;
  }
  await fs.unlink(BYPASS_ONCE_PATH);
  return true;
}

function parseSessionPins(raw: string): SessionPins | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionPins(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// What the operator reads when session pins were not used or not recorded on a stop. The stop goes
// on rather than blocking: a block here would trap the session behind a file another user may
// control, which is the fail-open decision the threat model records for a wedged hook. It is never
// silent. It is written after the decision line, so stderr never ends on a line that reads as a
// pass, and it always ends with what to change so pins work again.
interface PinNotice {
  // False when this stop did not compare pins, so the decision line must say so.
  driftChecked: boolean;
  message: string;
}

/**
 * The notice for pins this stop did not use. `reason` and `fix` are fixed text from usabl, except
 * that the pin store's reasons and fixes name directories and files, and those paths come from the
 * environment. So a reason or fix that is not fixed text goes in `carried`, which is printed inside
 * the frame, and the fixed line says where to find it.
 */
function pinsNotUsed(reason: string, fix: string, carried: string[] = []): PinNotice {
  return {
    driftChecked: false,
    message: framedMessage(
      [
        `NOT verified - usabl did not use session pins for this stop because ${reason}. ` +
          'Guarded policy drift during this session was not checked. usabl changed nothing there. ' +
          `To fix: ${fix}`,
      ],
      carried,
    ),
  };
}

/** A refusal from the pin store: its reason and fix name paths, so both go inside the frame. */
function pinsRefused(refusal: { reason: string; fix: string }): PinNotice {
  return pinsNotUsed(
    'the pin store refused to read them (its reason is under "pin reason" in the untrusted text below)',
    'see "pin fix" in the untrusted text below.',
    [`pin reason: ${refusal.reason}`, `pin fix: ${refusal.fix}`],
  );
}

function pinsNotRecorded(refusal: { reason: string; fix: string }, driftChecked: boolean): PinNotice {
  const consequence = driftChecked
    ? 'usabl checked guarded policy drift on this stop, but the next stop compares against the older pins.'
    : 'Guarded policy drift during this session cannot be checked until pins are recorded.';
  return {
    driftChecked,
    message: framedMessage(
      [
        'NOT verified - usabl could not record session pins for this stop because the pin store refused to ' +
          `write them (its reason is under "pin reason" in the untrusted text below). ${consequence} ` +
          'To fix: see "pin fix" in the untrusted text below.',
      ],
      [`pin reason: ${refusal.reason}`, `pin fix: ${refusal.fix}`],
    ),
  };
}

/**
 * The drift lines. The changed paths are file names in the repository, which anyone who can add a
 * file under a guarded directory chooses, so they are carried values and go inside the frame.
 */
// The names the session pins give the local checkout state, which are not files.
const CHECKOUT_STATE_NAMES: ReadonlySet<string> = new Set([SPARSE_STATE_NAME, EMPTY_SUBMODULES_NAME]);

function driftMessage(drift: string[], continuation: boolean, pinPath: string | null = null): string {
  const files = drift.filter((name) => !CHECKOUT_STATE_NAMES.has(name));
  const state = drift.length > files.length;
  if (!state) {
    const head =
      `NOT verified - guarded policy drift during this session: ${drift.length} guarded file(s) changed ` +
      'since the session pins were recorded, named under "drifted files" in the untrusted text below.';
    const next = continuation
      ? 'usabl let this stop through without blocking again (continuation already active). Next: tell the user that guarded policy files changed during this session and need review. Do not edit those files to make a later stop pass.'
      : 'Next: tell the user that guarded policy files changed during this session and need review. Do not edit those files to clear this block.';
    return framedMessage([head, next], [`drifted files: ${drift.join(', ')}`]);
  }
  const changed = files.length > 0 ? `${files.length} guarded file(s) and the sparse checkout or submodule state changed` : 'the sparse checkout or submodule state changed';
  const head =
    `NOT verified - guarded policy drift during this session: ${changed} since the session pins were recorded, ` +
    'named under "drifted files" in the untrusted text below.';
  const why =
    'That state decides which deleted files usabl reads as left out on purpose, so any change to it is drift. ' +
    'An honest git sparse-checkout command, git submodule update --init or git submodule deinit, or a merge, pull, ' +
    'rebase, or branch switch that adds or removes a submodule changes it too. usabl keeps the pins, so every later ' +
    'stop of this session blocks the same way.';
  const steps =
    'to review what changed since the session started. If the change was meant, the user deletes the pin file named ' +
    'under "pin fix" in the untrusted text below, and the next stop records new pins; otherwise the user puts the ' +
    'state back.';
  const policy = files.length > 0 ? ' The guarded policy files named there need review too.' : '';
  const own = ' Do not delete the pin file or change the state yourself to clear this block.';
  const next = continuation
    ? `usabl let this stop through without blocking again (continuation already active). Next: tell the user ${steps}${policy}${own}`
    : `Next: tell the user ${steps}${policy}${own}`;
  const pieces = [`drifted files: ${drift.join(', ')}`, ...(pinPath === null ? [] : [`pin fix: ${deletePinFileFix(pinPath)}`])];
  return framedMessage([head, why, next], pieces);
}

// Stored pins in a format an older usabl wrote. usabl cannot compare them, so it cannot tell
// whether policy changed in this session, and it says exactly that, never that policy changed.
// The pin file path comes from the environment, so it goes inside the frame.
function olderPinsMessage(pinPath: string, continuation: boolean): string {
  const head =
    'NOT verified - the session pins were written by an older usabl, so usabl cannot tell whether ' +
    'guarded policy files changed during this session.';
  const steps =
    'review the guarded policy files changed since the session started, then delete the pin file named ' +
    'under "pin fix" in the untrusted text below to go on.';
  const next = continuation
    ? `usabl let this stop through without blocking again (continuation already active). Next: tell the user to ${steps}`
    : `Next: tell the user to ${steps} Do not edit those files to clear this block.`;
  return framedMessage([head, next], [`pin fix: ${deletePinFileFix(pinPath)}`]);
}

// The config file the hook compares with the last commit before it parses anything.
const CONFIG_FILE = 'usabl.config.json';

/** Why the config stops this stop before anything parses it, or why it cannot be parsed. */
// `removed-on-both` is a removal on a branch whose trusted branch has no config any more either.
type ConfigProblem = 'differs' | 'missing' | 'removed' | 'removed-on-both' | 'unreadable' | 'unparseable' | 'no-ui-globs';

const REMOVED_LINE =
  'usabl.config.json is in the commit where this branch left the trusted branch, but it is missing from the working tree and from the last commit, ' +
  'so this branch removes usabl.config.json. CI reads that as a policy change, and usabl checked nothing on this stop.';

const CONFIG_PROBLEM_LINES: Record<ConfigProblem, string> = {
  differs:
    'usabl.config.json in the working tree differs from the last commit, so usabl did not parse it and checked nothing on this stop.',
  missing:
    'usabl.config.json is in the last commit but missing from the working tree, so usabl checked nothing on this stop.',
  removed: REMOVED_LINE,
  'removed-on-both': REMOVED_LINE,
  unreadable:
    'usabl.config.json in the working tree cannot be read (the error is under "error" in the untrusted text below), so usabl checked nothing on this stop.',
  unparseable:
    'usabl.config.json does not parse (the error is under "error" in the untrusted text below), so usabl cannot read its policy and checked nothing on this stop.',
  // The sentence usabl check, the CI judge, and usabl doctor print for the same config.
  'no-ui-globs': `${emptyUiFileGlobsRefusal(CONFIG_FILE)} usabl checked nothing on this stop.`,
};

// A config that does not parse is not cleared by a revert when the last commit holds the same
// bytes, so it has its own next step and its own way out. usabl init refuses to overwrite an
// existing config, so the way out names --force and what it overwrites.
const UNPARSEABLE_NEXT = 'Next: tell the user that usabl.config.json does not parse and needs a fix.';
const UNPARSEABLE_CLEARS =
  'This clears when usabl.config.json parses and matches the last commit. A committed config is fixed on a pull request that a code owner reviews. ' +
  'usabl init --force drafts a valid one, and it overwrites usabl.config.json and usabl.routes.json.';
const CHANGED_NEXT = 'Next: tell the user that usabl.config.json changed and needs approval on the pull request.';
// A config removed on the branch is cleared by putting it back, or by approval of the removal.
const REMOVED_NEXT =
  'Next: tell the user that this branch removes usabl.config.json. To keep usabl, restore usabl.config.json as it is at that commit. ' +
  'To remove usabl, a code owner approves the removal on the pull request.';
// When the trusted branch dropped usabl too, the branch only needs the update to clear this.
const REMOVED_ON_BOTH_NEXT =
  'The trusted branch has no usabl.config.json either. If usabl was removed there, update this branch from the trusted branch (merge it or rebase onto it), then stop again.';
// A config with no UI globs parses, so it has its own next step: the list needs filling in.
const NO_UI_GLOBS_NEXT = 'Next: tell the user that uiFileGlobs in usabl.config.json is empty and needs the files that render the UI.';
const NO_UI_GLOBS_CLEARS =
  'This clears when uiFileGlobs names the files that render the UI, or usabl.docs.json names a page, and usabl.config.json matches the last commit. ' +
  'A committed config is fixed on a pull request that a code owner reviews.';
// A block and a continuation that went through need different words: only a block can be cleared.
const DO_NOT_EDIT_BLOCK = 'Do not edit the file to clear this block.';
const DO_NOT_EDIT_CONTINUATION = 'Do not edit the file to make a later stop pass.';

/**
 * The line and the framed piece that name the guarded files the guard found changed, or nothing
 * when it found none. The paths are file names anyone who can add a file chooses, so they go
 * inside the frame.
 */
function guardedFilesNamed(paths: readonly string[]): { line: string; piece: string } | null {
  if (paths.length === 0) {
    return null;
  }
  return {
    line:
      `${guardedFilesHeadline(paths.length)}: ${paths.length}, named under "${GUARDED_FILES_LABEL}" in the untrusted text below. ` +
      'They need approval on the pull request too.',
    piece: `${GUARDED_FILES_LABEL}: ${paths.join(', ')}`,
  };
}

/**
 * The message for a config that blocks before the run. It says what happened, that nothing was
 * checked, what clears it, and the one lever a person has. Error text comes from the file system
 * or the parser and can carry config content, so it goes inside the frame. When the guard ran
 * first and found changed guarded files, they are named too.
 */
function configBlockMessage(
  problem: ConfigProblem,
  continuation: boolean,
  error: string | null,
  guardedPaths: readonly string[] = [],
): string {
  const lines = [`NOT verified - approval required: ${CONFIG_PROBLEM_LINES[problem]}`];
  if (continuation) {
    lines.push('usabl let this stop through without blocking again (continuation already active).');
  }
  const doNotEdit = continuation ? DO_NOT_EDIT_CONTINUATION : DO_NOT_EDIT_BLOCK;
  if (problem === 'unparseable') {
    lines.push(`${UNPARSEABLE_NEXT} ${doNotEdit}`, UNPARSEABLE_CLEARS);
  } else if (problem === 'no-ui-globs') {
    lines.push(`${NO_UI_GLOBS_NEXT} ${doNotEdit}`, NO_UI_GLOBS_CLEARS);
  } else if (problem === 'removed') {
    lines.push(REMOVED_NEXT, APPROVAL_REQUIRED_HOW_IT_CLEARS);
  } else if (problem === 'removed-on-both') {
    lines.push(REMOVED_NEXT, REMOVED_ON_BOTH_NEXT, APPROVAL_REQUIRED_HOW_IT_CLEARS);
  } else {
    lines.push(`${CHANGED_NEXT} ${doNotEdit}`, APPROVAL_REQUIRED_HOW_IT_CLEARS);
  }
  const guarded = guardedFilesNamed(guardedPaths);
  if (guarded !== null) {
    lines.push(guarded.line);
  }
  lines.push(APPROVAL_REQUIRED_HUMAN_LEVER);
  const pieces = [...(error === null ? [] : [`error: ${error}`]), ...(guarded === null ? [] : [guarded.piece])];
  return framedMessage(lines, pieces);
}

/**
 * The message for a stop where the guard or the session pins failed. Those are what tell the hook
 * whether guarded policy diverged, so the hook does not know, and it blocks
 * once, as it does for diverged files. Only the error's first line is carried, inside the frame.
 */
function guardFailureMessage(error: string, continuation: boolean): string {
  const lines = [
    'NOT verified - approval required: usabl could not tell whether guarded policy files changed, because the ' +
      'guard failed (the error is under "error" in the untrusted text below), so usabl checked nothing on this stop.',
  ];
  if (continuation) {
    lines.push('usabl let this stop through without blocking again (continuation already active).');
  }
  lines.push(
    'Next: tell the user that usabl could not check guarded policy on this stop. Run usabl check, and run usabl doctor if it fails the same way.',
    APPROVAL_REQUIRED_HUMAN_LEVER,
  );
  return framedMessage(lines, [`error: ${firstLine(error)}`]);
}

/** Thrown inside the hook when the guard or the pins failed. */
class GuardFailure extends Error {}

async function guarded<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new GuardFailure(errorMessage(err));
  }
}

// The note for a repository that has no usabl config in the working tree or in the last commit.
const NOT_CONFIGURED_HEAD =
  'NOT verified - usabl is not configured here: this repository has no usabl.config.json in the working tree or in the last commit, so usabl checked nothing on this stop.';
const NOT_CONFIGURED_NEXT =
  'Next: run usabl init to set usabl up in this repository, or ignore this note if the repository does not use usabl.';
const NOT_CONFIGURED_MESSAGE = `${NOT_CONFIGURED_HEAD} ${NOT_CONFIGURED_NEXT}`;

// What the not-configured note adds when the hook found no starting commit to compare with, so it
// could not tell whether the trusted branch has a config this branch removed.
const NOT_CONFIGURED_UNCOMPARED_MESSAGE =
  `${NOT_CONFIGURED_HEAD} usabl found no starting commit on a trusted branch to compare with, so it could not tell whether ` +
  `the trusted branch has a usabl.config.json that this branch removed. ${NOT_CONFIGURED_NEXT}`;

/**
 * The message for a branch that left the trusted branch before usabl was set up there. It blocks
 * once, and lets one continuation through, as the drift block does. The branch name comes from the
 * repository, so it goes inside the frame.
 */
function olderThanSetupMessage(branch: string, continuation: boolean): string {
  const text = olderThanSetupLines('nothing on this stop', 'stop again');
  const lines = [`NOT verified - ${text.head}`];
  if (continuation) {
    lines.push('usabl let this stop through without blocking again (continuation already active).');
  }
  lines.push(text.next, APPROVAL_REQUIRED_HUMAN_LEVER);
  return framedMessage(lines, [`trusted branch: ${branch}`]);
}

async function emitOlderThanSetup(
  ports: StopHookRunnerPorts,
  input: StopHookInput,
  options: StopHookOptions,
  branch: string,
  notices: string[] = [],
): Promise<void> {
  if (input.stopHookActive) {
    await emitProtocolAllow(ports, { message: olderThanSetupMessage(branch, true), notices }, options);
    return;
  }
  await emitProtocolBlock(ports, olderThanSetupMessage(branch, false), options);
  for (const notice of notices) {
    await writeStderr(ports, notice);
  }
}

/**
 * The note for a stop that started in a folder outside any git work tree. The hook could not find
 * the repository, so it could not tell whether usabl is set up there. The folder comes from the
 * environment, so it is printed only inside the frame.
 */
function outsideWorkTreeMessage(folder: string): string {
  return framedMessage(
    [
      'NOT verified - the stop hook ran in a folder outside any git work tree, or git could not run there ' +
        '(the folder is under "folder" in the untrusted text below), so it could not find the repository and ' +
        'checked nothing on this stop. usabl is not blocking this stop.',
      'Next: run usabl check from the project root before you call this change accessible.',
    ],
    [`folder: ${folder}`],
  );
}

// The raw bytes of a file read, or its text encoded as UTF-8 when the read kept no bytes.
function rawBytesOf(found: { text: string; bytes?: Uint8Array }): Uint8Array {
  return found.bytes ?? Buffer.from(found.text, 'utf8');
}

// The working config's bytes now, or null when it is missing or cannot be read. A read that fails
// is never the planned bytes, so no receipt is saved.
async function currentConfigBytes(ports: StopHookRunnerPorts): Promise<Uint8Array | null> {
  try {
    const { working } = await ports.readConfigBytes();
    return working.status === 'found' ? rawBytesOf(working) : null;
  } catch {
    return null;
  }
}

// `bytes` are the raw bytes the text was decoded from, which the receipt check compares and hashes.
type ConfigStep =
  | { kind: 'parse'; text: string; bytes: Uint8Array }
  | { kind: 'outside-work-tree' }
  | { kind: 'not-configured' }
  | { kind: 'block'; problem: ConfigProblem; error: string | null }
  | { kind: 'error'; reason: string };

/**
 * What the hook does with the config bytes, before anything parses them.
 *
 * The last commit is the trusted copy. When it holds the config, the working copy must match it
 * byte for byte, or the stop blocks as approval required: a corrupt or edited config used to throw
 * at parse time and end in an allow with "stop hook error". When neither place holds a config,
 * usabl is not set up here, unless this session already recorded pins for this root: then the
 * config was removed and committed during the session, and runStopHook treats it as drift. With no
 * such pins, runStopHook still asks the trusted branch, so a config removed and committed before
 * the first stop is not read as "not configured" (see notConfiguredStep).
 *
 * A config only in the working tree goes on to the run. When HEAD exists, this is a new,
 * uncommitted setup: the guard reports the config as a changed guarded file, and the run ends
 * approval required, which blocks. A repository with no commits, or an orphan branch with none
 * yet, has no HEAD: the guard cannot read it and throws with git's "make a first commit" step, so
 * the stop fails open with that disclosure and does not block. Git failing to read the last commit
 * is not one of the block cases either, so it stays an internal error and fails open with
 * disclosure. A folder outside any work tree has no repository to look at, and says so.
 */
function configStep(bytes: ConfigBytes): ConfigStep {
  const { working, head } = bytes;
  if (head.status === 'no-work-tree') {
    return { kind: 'outside-work-tree' };
  }
  if (head.status === 'unreadable') {
    return { kind: 'error', reason: `git could not read ${CONFIG_FILE} at the last commit: ${head.reason}` };
  }
  if (head.status === 'missing') {
    if (working.status === 'missing') {
      return { kind: 'not-configured' };
    }
    if (working.status === 'unreadable') {
      return { kind: 'error', reason: `${CONFIG_FILE} could not be read: ${working.reason}` };
    }
    return { kind: 'parse', text: working.text, bytes: rawBytesOf(working) };
  }
  if (working.status === 'missing') {
    return { kind: 'block', problem: 'missing', error: null };
  }
  if (working.status === 'unreadable') {
    return { kind: 'block', problem: 'unreadable', error: working.reason };
  }
  if (working.text !== head.text) {
    return { kind: 'block', problem: 'differs', error: null };
  }
  return { kind: 'parse', text: working.text, bytes: rawBytesOf(working) };
}

/**
 * Whether an earlier stop in this session recorded pins for this repository root. Only the hook
 * writes a pin file, and only after it read a committed config, so a pin file here, whether or not
 * it parses, means the root had a config earlier in the session. No usable session id means there
 * is no pin file to look for.
 */
async function earlierSessionPins(
  ports: StopHookRunnerPorts,
  input: StopHookInput,
): Promise<{ status: 'found' } | { status: 'missing' } | { status: 'refused'; reason: string; fix: string }> {
  const parsedSession = parseSessionId(input.sessionId);
  if ('notice' in parsedSession) {
    return { status: 'missing' };
  }
  const stored = await ports.pins.read(sessionPinFileName(parsedSession.sessionId, ports.cwd()));
  if (stored.status === 'refused') {
    return { status: 'refused', reason: stored.reason, fix: stored.fix };
  }
  return { status: stored.status };
}

/**
 * What a stop with no config in the working tree or the last commit finds on the trusted branch.
 * `removed`: the starting commit holds a config, so this branch removed it; `removed-on-both` is
 * the same when the tip of the trusted branch has none either, so an update may clear it.
 * `older-than-setup`: only the tip of the trusted branch holds one. `not-configured`: neither
 * holds one, so usabl is not set up here. `uncompared`: the hook found no starting commit, or the
 * lookup failed, so it could not tell. Ports a test builds without the lookup read as
 * `not-configured`, as before.
 */
async function notConfiguredStep(
  ports: StopHookRunnerPorts,
): Promise<
  { kind: 'removed' | 'removed-on-both' | 'not-configured' | 'uncompared' } | { kind: 'older-than-setup'; branch: string }
> {
  if (ports.findStartingCommit === undefined) {
    return { kind: 'not-configured' };
  }
  const start = await ports.findStartingCommit().catch(() => null);
  if (start === null || start.kind !== 'found') {
    return { kind: 'uncompared' };
  }
  if (start.policy === 'starting-commit') {
    return { kind: start.configOnTrustedBranch ? 'removed' : 'removed-on-both' };
  }
  if (start.policy === 'branch-older-than-setup') {
    return { kind: 'older-than-setup', branch: start.branch };
  }
  return { kind: 'not-configured' };
}

async function verifyStoredReceipt(
  ports: StopHookRunnerPorts,
  deps: Deps,
  config: UsablConfig,
  pins: StoredReceiptPinState,
  baseRevision: string | null,
): Promise<{ verified: boolean; details: string; notice: string | null }> {
  const receipt = await loadReceipt(ports.fs);
  if (receipt === null) {
    return { verified: false, details: 'no local receipt found', notice: null };
  }

  // Fast-path verification reuses the same verifier as run() so trust rules cannot diverge. The
  // starting commit is this stop's, so a receipt for another set of changes does not verify.
  const currentSourceTree = await deps.git.writeTree();
  const verification = await verifyReceipt(deps, config, receipt, currentSourceTree, baseRevision);
  if (verification.valid) {
    return { verified: true, details: formatStoredReceiptAllow(receipt.sourceTree, pins), notice: null };
  }
  return {
    verified: false,
    details: `receipt mismatch in ${verification.failedFields.join(', ') || 'unknown field'}`,
    notice: receiptNotUsedNotice(receiptFailureReasons(receipt, verification.failedFields, deps.clock()), verification.failedFields),
  };
}

/**
 * Why the stored receipt for this tree was not used, or null. Files changed since the receipt was
 * minted is the normal reason for a full check, so it adds no notice and a verified stop after an
 * edit stays quiet. Any other reason, such as a waiver that ended, is said after the decision. The
 * reasons are usabl's own sentences, so they are printed as usabl's words, each bounded.
 */
function receiptNotUsedNotice(reasons: readonly string[], failedFields: readonly string[]): string | null {
  if (failedFields.includes('sourceTree') || reasons.length === 0) {
    return null;
  }
  return (
    'Note: The stored receipt for this tree did not verify, so this stop ran a full check instead of using it. ' +
    `Why: ${reasons.map((reason) => boundField(reason, 'gapReason')).join('; ')}.`
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The repository root for the folder the hook starts in. The assistant can change directory
 * during a session, so the hook's own folder can be any subfolder, or a folder outside every
 * work tree, such as `.git`. A folder in no work tree is its own root, and the hook does not look
 * for a last commit there.
 */
export function findRepositoryRoot(startDir: string): { root: string; inRepository: boolean } {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitProcessEnvironment(),
    });
    const root = out.replace(/\r?\n$/, '');
    if (root.length > 0) {
      // git names a work tree that does not hold the hook's folder, or one where git finds another
      // repository, when a setting such as core.worktree points it at another folder. Reading that
      // folder would check files the dev server does not serve. The hook then works in its own
      // folder, where the git reader refuses to read such a work tree, so the stop blocks and says
      // so.
      if (!holds(root, startDir) || gitDirOf(root) !== gitDirOf(startDir)) {
        return { root: resolve(startDir), inRepository: true };
      }
      return { root: resolve(root), inRepository: true };
    }
  } catch {
    // Not a repository, or git is missing. Both mean there is no last commit to compare with.
  }
  return { root: resolve(startDir), inRepository: false };
}

// The repository git finds from a folder, as a real path, or null when it finds none.
function gitDirOf(folder: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: folder,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitProcessEnvironment(),
    });
    return realpathSync.native(out.replace(/\r?\n$/, ''));
  } catch {
    return null;
  }
}

// Whether the folder is the root or inside it, by real paths. A path that cannot be resolved is
// not held.
function holds(root: string, folder: string): boolean {
  try {
    const inside = relative(realpathSync.native(root), realpathSync.native(folder));
    return !inside.startsWith('..') && !isAbsolute(inside);
  } catch {
    return false;
  }
}

async function readWorkingConfig(root: string): Promise<FileBytes> {
  try {
    const bytes = await readFile(resolve(root, CONFIG_FILE));
    return { status: 'found', text: bytes.toString('utf8'), bytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'unreadable', reason: errorMessage(err) };
  }
}

async function readHeadConfig(root: string, inRepository: boolean): Promise<HeadBytes> {
  if (!inRepository) {
    return { status: 'no-work-tree' };
  }
  try {
    // A repository with no commits has no HEAD, so it has no committed config either.
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, stdio: 'ignore', env: gitProcessEnvironment() });
  } catch {
    return { status: 'missing' };
  }
  try {
    const text = await makeGitReader({ cwd: root }).show('HEAD', CONFIG_FILE);
    return text === null ? { status: 'missing' } : { status: 'found', text };
  } catch (err) {
    return { status: 'unreadable', reason: errorMessage(err) };
  }
}

function defaultFs(root: string): StopHookRunnerFs {
  // Receipt writes never follow a symbolic link. See makeReceiptFs.
  return {
    ...makeReceiptFs(root),
    unlink: async (path: string) => {
      try {
        await unlink(resolve(root, path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    },
  };
}

export interface StopHookRunnerPortOptions {
  // The user the session pins belong to. Absent means the user this process runs as. Tests set
  // it to another id, because a test cannot chown a file to make it another user's.
  uid?: number | null;
  // Where XDG_RUNTIME_DIR is read from. Absent means the process environment. Tests inject one
  // so a host setting never moves the pins they inspect.
  env?: Record<string, string | undefined>;
  // The folder the hook starts in. Absent means the process working directory. The hook works in
  // the repository root above it. CLAUDE_PROJECT_DIR, when it names a folder inside a work tree,
  // comes first. See hookRepository.
  startDir?: string;
  // True for the stop-hook command, which runs in a process of its own. The deadline counts from
  // the start of the process, so ports built inside a long-lived process, such as a test worker,
  // leave it off.
  deadline?: boolean;
}

function startRealTimer(ms: number): StopTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    expired,
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

// Resolves once everything written to the stream before it has been handed to the system, so an
// exit right after does not cut the answer short on a pipe.
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

function realDeadline(env: Record<string, string | undefined>): StopHookDeadlinePort {
  return {
    timeoutSetting: env[STOP_HOOK_TIMEOUT_ENV],
    elapsedMs: () => process.uptime() * 1000,
    startTimer: startRealTimer,
    endProcess: async () => {
      await Promise.all([drained(process.stdout), drained(process.stderr)]);
      process.exit(0);
    },
  };
}

/**
 * The folder CLAUDE_PROJECT_DIR names, or null. Claude Code sets it to the project root, so the
 * hook starts there and does not follow the assistant into a folder outside the work tree. A value
 * that is empty, or that names no folder, is ignored. A folder outside every work tree does not
 * win over a hook folder inside one: see hookRepository.
 */
function claudeProjectDir(env: Record<string, string | undefined>): string | null {
  const value = env['CLAUDE_PROJECT_DIR'];
  if (value === undefined || value.length === 0) {
    return null;
  }
  try {
    const path = resolve(value);
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

/**
 * The repository the hook works in. CLAUDE_PROJECT_DIR comes first when it is inside a work tree.
 * A session started in a parent folder that is not a repository sets it there, so when it is in
 * no work tree and the hook's own folder is in one, the hook uses its own folder's work tree, and
 * `ownFolderInstead` is true so every decision says which repository it checked: the hook's folder
 * follows the assistant, so that may not be the repository the session changed. When neither is in
 * a work tree, the hook says so, naming CLAUDE_PROJECT_DIR when it was set, as before. The rule is
 * the same for both protocols.
 */
function hookRepository(
  projectDir: string | null,
  ownDir: string,
): { root: string; inRepository: boolean; ownFolderInstead: boolean } {
  if (projectDir === null) {
    return { ...findRepositoryRoot(ownDir), ownFolderInstead: false };
  }
  const fromProject = findRepositoryRoot(projectDir);
  if (fromProject.inRepository) {
    return { ...fromProject, ownFolderInstead: false };
  }
  const fromOwn = findRepositoryRoot(ownDir);
  return fromOwn.inRepository ? { ...fromOwn, ownFolderInstead: true } : { ...fromProject, ownFolderInstead: false };
}

export function makeStopHookRunnerPorts(options: StopHookRunnerPortOptions = {}): StopHookRunnerPorts {
  const uid = options.uid === undefined ? currentUid() : options.uid;
  const env = options.env ?? process.env;
  const dir = resolveSessionPinDir({ env, tmpDir: tmpdir(), uid });
  const { root, inRepository, ownFolderInstead } = hookRepository(claudeProjectDir(env), options.startDir ?? process.cwd());
  return {
    ...(ownFolderInstead ? { repositoryFromOwnFolder: true } : {}),
    fs: defaultFs(root),
    pins: makeFsSessionPinStore({ dir, uid }),
    cwd: () => root,
    stdoutWrite: async (text: string) => {
      process.stdout.write(text);
    },
    stderrWrite: async (text: string) => {
      process.stderr.write(text);
    },
    readConfigBytes: async () => {
      const [working, head] = await Promise.all([readWorkingConfig(root), readHeadConfig(root, inRepository)]);
      return { working, head };
    },
    loadConfig: async (text: string) => parseConfigText(text),
    buildDeps: async (config: UsablConfig) => buildDeps(config, { cwd: root }),
    runEngine: async (deps: Deps, config: UsablConfig, opts?: RunOptions) => run(deps, config, opts ?? {}),
    // Outside a work tree the hook stops before it looks (see configStep), and there is no branch
    // and no committed work to compare. Inside one, git answers.
    findStartingCommit: async () =>
      inRepository ? findStartingCommit(scopeGit(root)) : { kind: 'no-trusted-branch' as const },
    evaluateDecision: evaluateStopDecision,
    ...(options.deadline === true ? { deadline: realDeadline(env) } : {}),
  };
}

export interface StopHookOptions {
  cursorMode: boolean;
}

const DEFAULT_OPTIONS: StopHookOptions = { cursorMode: false };

// Protocol-aware block emitter. Claude uses decision: block, Cursor uses followup_message.
async function emitProtocolBlock(ports: StopHookRunnerPorts, reason: string, options: StopHookOptions): Promise<void> {
  if (options.cursorMode) {
    await emitCursorBlock(ports, reason);
  } else {
    await emitBlock(ports, reason);
  }
  // Which repository was checked follows a block the way every other note does.
  const note = ownRepositoryNote(ports);
  if (note !== null) {
    await writeStderr(ports, note);
  }
}

/**
 * The note for a stop that checked the repository the assistant stopped in, because
 * CLAUDE_PROJECT_DIR named a folder outside any repository, or null for any other stop. The
 * assistant's folder follows it when it changes directory, so this repository may not be the one
 * the session changed. Its top-level folder name comes from the file system, so it is printed only
 * inside the frame.
 */
function ownRepositoryNote(ports: StopHookRunnerPorts): string | null {
  if (ports.repositoryFromOwnFolder !== true) {
    return null;
  }
  return framedMessage(
    [
      'Note: the project folder (CLAUDE_PROJECT_DIR) is outside any git repository, so usabl checked the repository ' +
        'the assistant was in when it stopped (named under "repository checked" in the untrusted text below). ' +
        'If the work was in another repository, run usabl check there.',
    ],
    [`repository checked: ${basename(ports.cwd())}`],
  );
}

/** What an allow says, in the order it is written. */
interface AllowText {
  // The decision line and what follows it in one message.
  message: string;
  // Notices written after the decision line: a receipt that was not saved, pins that were not used.
  notices?: string[];
  // True only for a VERIFIED line or an idle line (no UI file changed, so nothing to check). With
  // no notice, these are the allows a person does not need to see: neither is a failure to look.
  quiet?: boolean;
}

/**
 * Whether a decision allow is a quiet one: the gate verified the change, or the run was idle.
 * The idle line is usabl's own words and ends "You may stop.". An idle run with diverged guarded
 * policy that was let through on a continuation opens with the same verdict word, but it says
 * NOT verified and ends in the untrusted frame, so it is never quiet.
 */
function isQuietDecision(result: Result, message: string): boolean {
  if (result.verdict === 'verified') {
    return message.startsWith('VERIFIED');
  }
  return (
    result.verdict === null &&
    result.coverage.nothingToCheck === true &&
    message.startsWith('NO VERDICT: IDLE') &&
    message.endsWith('You may stop.') &&
    !message.includes('NOT verified')
  );
}

/**
 * Protocol-aware allow emitter. Every line goes to stderr, as before. Cursor must also get {} on
 * stdout so the hook response is valid JSON. Claude Code does not show the stderr of a Stop hook
 * that exits 0, and sends its plain stdout to the debug log, so an allow that carries a notice
 * also writes one JSON object with a systemMessage field, which Claude Code shows to the person.
 * The text is the same text stderr gets, so its carried values are already scrubbed and framed.
 */
async function emitProtocolAllow(ports: StopHookRunnerPorts, text: AllowText, options: StopHookOptions): Promise<void> {
  const note = ownRepositoryNote(ports);
  const lines = [text.message, ...(note === null ? [] : [note]), ...(text.notices ?? [])];
  for (const line of lines) {
    await writeStderr(ports, line);
  }
  if (options.cursorMode) {
    await emitCursorAllow(ports);
    return;
  }
  if (text.quiet === true && lines.length === 1) {
    return;
  }
  await emitSystemMessage(ports, lines.join('\n'));
}

async function emitSystemMessage(ports: StopHookRunnerPorts, text: string): Promise<void> {
  await ports.stdoutWrite(JSON.stringify({ systemMessage: text }) + '\n');
}

function pinNotices(notice: PinNotice | null): string[] {
  return notice === null ? [] : [notice.message];
}

function scopeNotes(scope: { note: string | null }): string[] {
  return scope.note === null ? [] : [scope.note];
}

/**
 * A config block lets one continuation through while stop_hook_active is set, as every other
 * block does, so a person who edits the config on purpose is never looped.
 */
async function emitConfigBlock(
  ports: StopHookRunnerPorts,
  input: StopHookInput,
  options: StopHookOptions,
  problem: ConfigProblem,
  error: string | null,
  guardedPaths: readonly string[] = [],
): Promise<void> {
  if (input.stopHookActive) {
    await emitProtocolAllow(ports, { message: configBlockMessage(problem, true, error, guardedPaths) }, options);
    return;
  }
  await emitProtocolBlock(ports, configBlockMessage(problem, false, error, guardedPaths), options);
}

/**
 * What one stop checks. `scan` carries the options its run gets and the commit the changed list
 * was taken from, or null for uncommitted changes only; the receipt records it, and a stored
 * receipt verifies only for the same one. `gap` means the stop cannot tell which changes CI will
 * check, so it checks nothing and blocks.
 */
type StopScope =
  | {
      kind: 'scan';
      runOptions: RunOptions;
      baseRevision: string | null;
      // The commit policy is read and guarded at, or null for the working tree compared with the
      // last commit.
      policyRef: string | null;
      policyFromBranch: boolean;
      note: string | null;
    }
  | Extract<BranchScope, { kind: 'gap' } | { kind: 'older-than-setup' }>;

/**
 * What this stop checks: what CI will check. The scope comes from resolveBranchScope, the same
 * function `usabl check --branch-scope` uses, so that check and a stop list the same changes and
 * bind the same starting commit. See stop-hook-scope.ts.
 *
 * With a starting commit, the run reads policy at that commit, as CI reads it at the base of the
 * pull request: the guard compares the working tree with it, and the floor, the waivers, and a
 * changed config are read from it. A policy change committed on the branch is then a guarded
 * change, as it is in CI. Without one, the run keeps the last commit as the reference.
 *
 * On a branch that sets usabl up, neither the starting commit nor any branch of origin has a
 * config, so there is no trusted policy to read. The run checks the same changes, reads the branch's own
 * policy, and compares it with the last commit, as with no trusted branch, and the stop says on
 * its verdict line that this policy is not approved yet. CI still asks a code owner to approve it.
 */
async function stopScope(ports: StopHookRunnerPorts, deps: Deps): Promise<StopScope> {
  if (ports.findStartingCommit === undefined) {
    return { kind: 'scan', runOptions: {}, baseRevision: null, policyRef: null, policyFromBranch: false, note: null };
  }
  const scope = await resolveBranchScope(ports.findStartingCommit, deps.git);
  if (scope.kind !== 'scan') {
    return scope;
  }
  const runOptions: RunOptions =
    scope.changedFiles === undefined || scope.baseRevision === null
      ? {}
      : {
          changedFiles: scope.changedFiles,
          baseRevision: scope.baseRevision,
          ...(scope.policyRef === null ? {} : { trustedRef: scope.policyRef }),
        };
  return {
    kind: 'scan',
    runOptions,
    baseRevision: scope.baseRevision,
    policyRef: scope.policyRef,
    policyFromBranch: scope.policyFromBranch,
    note: scope.note,
  };
}

/**
 * The message for a stop that could not tell which committed changes CI will check. It checked
 * nothing, so it is a coverage gap and blocks once, as every other gap does. The branch name and
 * git's error come from the repository, so they go inside the frame.
 */
function scopeGapMessage(
  scope: Extract<StopScope, { kind: 'gap' }>,
  continuation: boolean,
  guardedPaths: readonly string[],
): string {
  const lines = [scopeGapHeadline(scope.problem, ' on this stop')];
  if (continuation) {
    lines.push('usabl let this stop through without blocking again (continuation already active).');
  }
  lines.push(scopeGapNextStep(scope.problem, 'stop again'));
  const guarded = guardedFilesNamed(guardedPaths);
  if (guarded !== null) {
    lines.push(guarded.line);
  }
  lines.push(APPROVAL_REQUIRED_HUMAN_LEVER);
  const detail = scopeGapDetailPiece(scope);
  return framedMessage(lines, [
    `trusted branch: ${scope.branch}`,
    ...(detail === null ? [] : [detail]),
    ...(guarded === null ? [] : [guarded.piece]),
  ]);
}

// usabl.docs.json at the repository root. A read that fails is no manifest, never proof of one.
async function readDocsManifest(fs: StopHookRunnerFs): Promise<string | null> {
  try {
    return await fs.readFile('usabl.docs.json');
  } catch {
    return null;
  }
}

/** What the checks share with runStopHook, which closes the browser and words a timed-out stop. */
interface StopRunState {
  deps: Deps | null;
  // The check the advice names. It stays usabl check until the stop finds a starting commit.
  checkCommand: CheckCommand;
}

/**
 * Who writes the answer of a stop that has a deadline. Only one answer may reach the host: two
 * JSON objects on stdout are no answer the host can read, and a deadline message that says no
 * receipt was saved must not sit next to a receipt the checks saved. The first to claim it keeps it.
 */
interface AnswerClaim {
  owner: 'none' | 'checks' | 'deadline';
}

// True when the checks hold the answer, claiming it first when nobody holds it yet.
function checksHoldAnswer(claim: AnswerClaim): boolean {
  if (claim.owner === 'none') {
    claim.owner = 'checks';
  }
  return claim.owner === 'checks';
}

/**
 * Ports for checks that race the deadline. The checks write only their answer: the receipt (and
 * the bypass file they remove) and the output. The first such write claims the answer for them.
 * Once the deadline holds it, nothing the checks still produce reaches the output, the receipt,
 * or the pins, because the answer then says the check was not finished. Reads pass through.
 */
function claimedPorts(ports: StopHookRunnerPorts, claim: AnswerClaim): StopHookRunnerPorts {
  const refused = { status: 'refused', reason: 'the stop ran out of time', fix: 'stop again.' } as const;
  const { deadline: _deadline, ...rest } = ports;
  return {
    ...rest,
    fs: {
      readFile: (path) => ports.fs.readFile(path),
      writeFile: async (path, contents) => {
        if (checksHoldAnswer(claim)) {
          await ports.fs.writeFile(path, contents);
        }
      },
      mkdir: async (path) => {
        if (checksHoldAnswer(claim)) {
          await ports.fs.mkdir(path);
        }
      },
      unlink: async (path) => {
        if (checksHoldAnswer(claim)) {
          await ports.fs.unlink(path);
        }
      },
    },
    // Pins are written before the scan, not as part of the answer, so they claim nothing.
    pins: {
      read: (name) => ports.pins.read(name),
      locate: (name) => ports.pins.locate(name),
      create: async (name, contents) => (claim.owner === 'deadline' ? refused : ports.pins.create(name, contents)),
      replace: async (name, contents) => (claim.owner === 'deadline' ? refused : ports.pins.replace(name, contents)),
    },
    stdoutWrite: async (text) => {
      if (checksHoldAnswer(claim)) {
        await ports.stdoutWrite(text);
      }
    },
    stderrWrite: async (text) => {
      if (checksHoldAnswer(claim)) {
        await ports.stderrWrite(text);
      }
    },
  };
}

// Waits for `step`, but for no longer than `ms`. A step that fails counts as ended.
async function boundedWait(deadline: StopHookDeadlinePort, step: Promise<unknown>, ms: number): Promise<void> {
  const wait = deadline.startTimer(ms);
  try {
    await Promise.race([step.then(noop, noop), wait.expired]);
  } finally {
    wait.cancel();
  }
}

function noop(): void {}

async function closeBrowser(state: StopRunState): Promise<void> {
  if (state.deps !== null) {
    await state.deps.browser.close();
  }
}

/**
 * Runs one stop. With a deadline port, the checks race the runner's own deadline, which is shorter
 * than the host's limit (see stop-hook-deadline.ts). When the deadline comes before the checks
 * start their answer, the stop blocks once with the out-of-time message, or lets an active
 * continuation through once with it, as the drift and older-pins blocks do. The browser is closed,
 * which stops the scan, no receipt is saved, and the process ends so the host reads the answer in
 * time. When the deadline comes while the checks are writing their answer, that answer stands: the
 * runner waits a short time for it, then closes the browser and ends the process. Every wait after
 * the deadline is bounded by a third of the time left before the host's limit (see
 * afterDeadlineWaitMs), so the process ends inside the limit as long as npm starting the hook
 * took less than the last third. Limit: for a host limit of a few seconds, starting npm and node
 * alone can take longer than that, and nothing usabl does can end inside it.
 */
export async function runStopHook(
  input: StopHookInput,
  ports: StopHookRunnerPorts,
  options: StopHookOptions = DEFAULT_OPTIONS,
): Promise<number> {
  const state: StopRunState = { deps: null, checkCommand: 'usabl check' };
  const deadline = ports.deadline;
  if (deadline === undefined) {
    try {
      return await runStopChecks(input, ports, options, state);
    } finally {
      await closeBrowser(state);
    }
  }

  const limit = hostLimit(deadline.timeoutSetting, options.cursorMode);
  const timer = deadline.startTimer(Math.max(0, runnerDeadlineSeconds(limit.seconds) * 1000 - deadline.elapsedMs()));
  const claim: AnswerClaim = { owner: 'none' };
  // The deadline takes the answer as the timer fires, before anything else hears of it, unless
  // the checks already hold it.
  const reached = timer.expired.then(() => {
    if (claim.owner === 'none') {
      claim.owner = 'deadline';
    }
    return { kind: claim.owner === 'deadline' ? ('deadline' as const) : ('answering' as const) };
  });

  // After the checks answered, the browser closes before the deadline or is not waited for: the
  // answer is written, and the process ends so the host reads it in time.
  const closeAfterAnswer = async (): Promise<void> => {
    const closing = closeBrowser(state).then(() => 'closed' as const);
    closing.catch(noop);
    const ended = await Promise.race([closing, timer.expired.then(() => 'late' as const)]);
    timer.cancel();
    if (ended === 'late') {
      await deadline.endProcess();
    }
  };

  const work = runStopChecks(input, claimedPorts(ports, claim), options, state);
  let outcome: { kind: 'done'; code: number } | Awaited<typeof reached>;
  try {
    outcome = await Promise.race([work.then((code) => ({ kind: 'done' as const, code })), reached]);
  } catch (err) {
    // The checks failed before the deadline. The timer still runs and the browser is open.
    await closeAfterAnswer().catch(noop);
    throw err;
  }
  if (outcome.kind === 'done') {
    await closeAfterAnswer();
    return outcome.code;
  }

  // The checks may still settle later. Nothing they write after this point is used.
  work.catch(noop);
  if (outcome.kind === 'answering') {
    // The checks were writing their answer when the deadline came. That answer stands, and the
    // deadline writes none of its own.
    try {
      await boundedWait(deadline, work, afterDeadlineWaitMs(limit.seconds, ANSWER_FINISH_WAIT_MS));
      await boundedWait(deadline, closeBrowser(state), afterDeadlineWaitMs(limit.seconds, BROWSER_CLOSE_WAIT_MS));
    } finally {
      await deadline.endProcess();
    }
    return 0;
  }
  const message = deadlineMessage({
    limit,
    cursorMode: options.cursorMode,
    continuation: input.stopHookActive,
    checkCommand: state.checkCommand,
  });
  try {
    if (input.stopHookActive) {
      await emitProtocolAllow(ports, { message }, options);
    } else {
      await emitProtocolBlock(ports, message, options);
    }
  } finally {
    // Closing the browser stops the scan. A close that hangs is not waited for past a short limit,
    // because the process ends next anyway.
    try {
      await boundedWait(deadline, closeBrowser(state), afterDeadlineWaitMs(limit.seconds, BROWSER_CLOSE_WAIT_MS));
    } finally {
      await deadline.endProcess();
    }
  }
  return 0;
}

async function runStopChecks(
  input: StopHookInput,
  ports: StopHookRunnerPorts,
  options: StopHookOptions,
  state: StopRunState,
): Promise<number> {
  let pinNotice: PinNotice | null = null;
  try {
    if (await consumeBypassOnce(ports.fs)) {
      // One-shot bypass is loud so temporary overrides cannot become sticky silent greens.
      await emitProtocolAllow(ports, { message: 'NOT verified - BYPASS consumed for this stop only.' }, options);
      return 0;
    }

    // The config is compared with the last commit before anything parses it. See configStep.
    const step = configStep(await ports.readConfigBytes());
    if (step.kind === 'error') {
      throw new Error(step.reason);
    }
    if (step.kind === 'outside-work-tree') {
      await emitProtocolAllow(ports, { message: outsideWorkTreeMessage(ports.cwd()) }, options);
      return 0;
    }
    if (step.kind === 'not-configured') {
      // Pins for this session and root mean an earlier stop here read a committed config, so a
      // config now missing from the working tree and from HEAD was removed and committed during
      // the session. That is drift, and it goes through the drift block.
      const earlier = await earlierSessionPins(ports, input);
      if (earlier.status === 'found') {
        if (input.stopHookActive) {
          await emitProtocolAllow(ports, { message: driftMessage([CONFIG_FILE], true) }, options);
          return 0;
        }
        await emitProtocolBlock(ports, driftMessage([CONFIG_FILE], false), options);
        return 0;
      }
      const pinNotes = earlier.status === 'refused' ? [pinsRefused(earlier).message] : [];
      // Without pins, the trusted branch tells whether usabl is set up. A config at the starting
      // commit that this branch no longer has is a policy change, as CI reads it, and blocks as
      // approval required. A config only on the trusted branch means the branch is older than the
      // setup. See notConfiguredStep.
      const known = await notConfiguredStep(ports);
      if (known.kind === 'removed' || known.kind === 'removed-on-both') {
        await emitConfigBlock(ports, input, options, known.kind, null);
        return 0;
      }
      if (known.kind === 'older-than-setup') {
        await emitOlderThanSetup(ports, input, options, known.branch, pinNotes);
        return 0;
      }
      const message = known.kind === 'uncompared' ? NOT_CONFIGURED_UNCOMPARED_MESSAGE : NOT_CONFIGURED_MESSAGE;
      await emitProtocolAllow(ports, { message, notices: pinNotes }, options);
      return 0;
    }
    if (step.kind === 'block') {
      await emitConfigBlock(ports, input, options, step.problem, step.error);
      return 0;
    }
    let config: UsablConfig;
    try {
      config = await ports.loadConfig(step.text);
    } catch (err) {
      await emitConfigBlock(ports, input, options, 'unparseable', errorMessage(err));
      return 0;
    }
    // A config with no UI globs would read every stop as idle. The rule is the loader's, with the
    // docs manifest read from the repository root through the hook's file port.
    const noUiGlobs =
      config.uiFileGlobs.length === 0 && uiFileGlobsRefusal(config, await readDocsManifest(ports.fs), CONFIG_FILE) !== null;
    // The guard runs before the empty list blocks, so a waiver or floor weakened in the same
    // session is named on that stop, and a guard that fails blocks as a guard failure. Any other
    // failure here, such as no last commit, fails open below, so an empty list still blocks on it,
    // as it did before the guard ran first.
    let guardDeps: Deps;
    let dirtyGuardedPaths: string[];
    try {
      const built = await ports.buildDeps(config);
      state.deps = built;
      guardDeps = built;
      dirtyGuardedPaths = await guarded(() => checkGuard(built));
    } catch (err) {
      const blocksAsGuardFailure = err instanceof GuardFailure && err.message !== NO_HEAD_MESSAGE;
      if (noUiGlobs && !blocksAsGuardFailure) {
        await emitConfigBlock(ports, input, options, 'no-ui-globs', null);
        return 0;
      }
      throw err;
    }
    if (noUiGlobs) {
      await emitConfigBlock(ports, input, options, 'no-ui-globs', null, dirtyGuardedPaths);
      return 0;
    }

    // Session pins are compared before the receipt fast path. A receipt binds the committed policy
    // as it is when the receipt was minted, so a policy weakened and committed during the session,
    // then checked under the weaker policy, mints a receipt that matches. Only the pins see that
    // drift, so a stored receipt must never answer a stop before they are compared.
    let pinsCompared = false;
    const parsedSession = parseSessionId(input.sessionId);
    if ('notice' in parsedSession) {
      // No usable session id means no pins to compare. That is never silent: an allow on this stop
      // says session drift was not checked, and the notice says why.
      pinNotice = parsedSession.notice;
    } else {
      const pinName = sessionPinFileName(parsedSession.sessionId, ports.cwd());
      const stored = await ports.pins.read(pinName);
      const previousPins = stored.status === 'found' ? parseSessionPins(stored.contents) : null;
      if (stored.status === 'refused') {
        // Never read as "no pins yet": that is exactly what would adopt a planted file.
        pinNotice = pinsRefused(stored);
      } else if (stored.status === 'found' && previousPins === null) {
        // A pin file of ours that does not parse is not "no pins yet" either. Recording fresh pins
        // over it would take whatever is committed now, a tamper included, as the baseline.
        pinNotice = pinsNotUsed(
          'the session pin file does not hold pins usabl can read',
          'see "pin fix" in the untrusted text below.',
          [`pin fix: ${deletePinFileFix(ports.pins.locate(pinName))}`],
        );
      } else if (previousPins !== null && !pinsAreCurrent(previousPins)) {
        // Pins an older usabl wrote say nothing this usabl can compare, so it cannot tell whether
        // policy was weakened and committed earlier in this session. A full check now would run
        // under that policy and could pass, and replacing the pins would take it as the baseline.
        // So the stop takes the drift path: it blocks, or lets one continuation through, keeps the
        // pins, and never reaches the receipt fast path. The message never says policy changed.
        const message = olderPinsMessage(ports.pins.locate(pinName), input.stopHookActive);
        if (input.stopHookActive) {
          await emitProtocolAllow(ports, { message }, options);
          return 0;
        }
        await emitProtocolBlock(ports, message, options);
        return 0;
      } else {
        const nextPins = await guarded(() => computeSessionPins(guardDeps, config));
        const serialized = JSON.stringify(nextPins, null, 2);

        if (previousPins === null) {
          // No pins yet: this stop records the first pins for the session.
          const written = await ports.pins.create(pinName, serialized);
          if (written.status === 'refused') {
            pinNotice = pinsNotRecorded(written, false);
          }
        } else {
          const drift = diffSessionPins(previousPins, nextPins);
          if (drift.length > 0) {
            if (input.stopHookActive) {
              // Allow one continuation while active to avoid recursive stop-hook loops.
              // We keep the previous pins so a retry cannot convert detected drift into a silent allow.
              await emitProtocolAllow(ports, { message: driftMessage(drift, true, ports.pins.locate(pinName)) }, options);
              return 0;
            }
            // Drift is a trust boundary. Overwriting pins here would let "retry stop" clear the evidence.
            await emitProtocolBlock(ports, driftMessage(drift, false, ports.pins.locate(pinName)), options);
            return 0;
          }
          pinsCompared = true;
          const written = await ports.pins.replace(pinName, serialized);
          if (written.status === 'refused') {
            pinNotice = pinsNotRecorded(written, true);
          }
        }
      }
    }

    // What this stop checks: what CI will check. See stopScope.
    const scope = await stopScope(ports, guardDeps);
    if (scope.kind === 'gap') {
      if (input.stopHookActive) {
        await emitProtocolAllow(
          ports,
          { message: scopeGapMessage(scope, true, dirtyGuardedPaths), notices: pinNotices(pinNotice) },
          options,
        );
        return 0;
      }
      await emitProtocolBlock(ports, scopeGapMessage(scope, false, dirtyGuardedPaths), options);
      for (const notice of pinNotices(pinNotice)) {
        await writeStderr(ports, notice);
      }
      return 0;
    }
    if (scope.kind === 'older-than-setup') {
      await emitOlderThanSetup(ports, input, options, scope.branch, pinNotices(pinNotice));
      return 0;
    }
    state.checkCommand = checkCommandFor(scope.baseRevision);
    const checkCommand = state.checkCommand;
    // With no trusted branch the allow line itself says so, not only the note after it.
    const noTrustedBranch = scope.note === NO_TRUSTED_BRANCH_NOTE;
    // The session pins and the guard above compare with the last commit, so a policy change
    // committed on the branch before the first stop passes both. CI compares policy with the base
    // of the pull request, so the stop also compares it with the starting commit. A file found
    // here is a guarded change: it skips the receipt fast path and blocks for approval. On a
    // branch that sets usabl up there is no policy at the starting commit to compare with.
    const startingCommit = scope.policyRef;
    if (startingCommit !== null) {
      const sinceStart = await guarded(() => checkGuard(guardDeps, startingCommit));
      dirtyGuardedPaths = [...new Set([...dirtyGuardedPaths, ...sinceStart])].sort();
    }

    let receiptNotUsed: string | null = null;
    if (dirtyGuardedPaths.length === 0) {
      // Receipt trust binds committed state, while checkGuard catches local guarded edits before any fast allow.
      // The stored receipt only offers a fast allow. A receipt the hook cannot read or check is no
      // guard failure: the hook drops the fast path and runs the full check below.
      const receiptCheck = await verifyStoredReceipt(ports, guardDeps, config, {
        pinsCompared,
        sessionDriftChecked: pinNotice?.driftChecked ?? true,
        ...(scope.policyFromBranch ? { policyFromBranch: true } : {}),
        ...(ports.repositoryFromOwnFolder === true ? { repositoryFromOwnFolder: true } : {}),
        ...(noTrustedBranch ? { noTrustedBranch: true } : {}),
      }, scope.baseRevision).catch(() => ({ verified: false, details: 'the stored receipt could not be checked', notice: null }));
      receiptNotUsed = receiptCheck.notice;
      if (receiptCheck.verified) {
        await emitProtocolAllow(
          ports,
          { message: receiptCheck.details, notices: [...scopeNotes(scope), ...pinNotices(pinNotice)], quiet: true },
          options,
        );
        return 0;
      }
    }

    const result = await ports.runEngine(guardDeps, config, scope.runOptions);
    let receiptNotice: string | null = null;
    const receipt = receiptToSave(result, { ci: false });
    // The run binds the root config's bytes when it starts, after this stop read them to plan. The
    // file is read once more here, and the receipt is saved only while it holds the planned bytes
    // and the receipt binds those bytes. See planned-config.ts.
    const configCheck =
      receipt === null
        ? null
        : await receiptConfigCheck({
            deps: guardDeps,
            config,
            receipt,
            plannedBytes: step.bytes,
            currentBytes: await currentConfigBytes(ports),
          });
    if (configCheck !== null && configCheck !== 'bound') {
      receiptNotice = `usabl: ${noReceiptMessage(configCheck)}`;
    } else if (receipt !== null) {
      const saved = await saveReceipt(ports.fs, receipt, checkCommand);
      // A refused save changes no verdict. It is said after the decision, so the decision line
      // still comes first.
      receiptNotice = saved.status === 'refused' ? saved.message : null;
    }

    // The hook's own guard result travels with the decision, so diverged policy blocks even on a
    // run that crashed and carried no paths of its own.
    const ctx: HookContext = {
      stopHookActive: input.stopHookActive,
      guardDivergedPaths: dirtyGuardedPaths,
      checkCommand,
      ...(startingCommit === null ? {} : { policyFromStartingCommit: true }),
      ...(scope.policyFromBranch ? { policyFromBranch: true } : {}),
      ...(ports.repositoryFromOwnFolder === true ? { repositoryFromOwnFolder: true } : {}),
      ...(pinNotice === null ? {} : { sessionDriftChecked: pinNotice.driftChecked }),
      ...(noTrustedBranch ? { noTrustedBranch: true } : {}),
    };
    const decision = ports.evaluateDecision(result, ctx, config);
    const notices = [
      // The notice says a full check ran, so it is added only when the run reached a verdict. An
      // idle run checked nothing and a failed run proved nothing; either stop reads as it does
      // without a stored receipt.
      ...(receiptNotUsed === null || result.verdict === null ? [] : [receiptNotUsed]),
      ...(receiptNotice === null ? [] : [receiptNotice]),
      // What this stop did not check goes with every decision, the idle one included.
      ...scopeNotes(scope),
      ...pinNotices(pinNotice),
    ];
    if (decision.block) {
      // A block is sent as before. The notices follow it on stderr.
      await emitProtocolBlock(ports, decision.message, options);
      for (const notice of notices) {
        await writeStderr(ports, notice);
      }
      return 0;
    }
    await emitProtocolAllow(
      ports,
      { message: decision.message, notices, quiet: isQuietDecision(result, decision.message) },
      options,
    );
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    // A repository with no last commit has nothing to compare with, and keeps its own fail-open
    // disclosure (see configStep). Any other guard failure means the hook cannot tell whether
    // guarded policy diverged, so it blocks once, as for diverged files.
    if (err instanceof GuardFailure && message !== NO_HEAD_MESSAGE) {
      if (input.stopHookActive) {
        await emitProtocolAllow(ports, { message: guardFailureMessage(message, true), notices: pinNotices(pinNotice) }, options);
      } else {
        await emitProtocolBlock(ports, guardFailureMessage(message, false), options);
      }
      return 0;
    }
    // Hook errors fail open with disclosure because a wedged stop hook is worse than an honest unverified allow.
    // The error text can carry a path or a value from the repository, so it goes inside the frame.
    await emitProtocolAllow(
      ports,
      {
        message: framedMessage(
          [
            'NOT verified - stop hook error: the hook failed before it reached a verdict, so it proved nothing ' +
              'about this change. usabl is not blocking this stop. The error is under "error" in the untrusted text below.',
            `Next: run ${state.checkCommand}, or check the change by hand, before you call this change accessible.`,
          ],
          [`error: ${message}`],
        ),
        notices: pinNotices(pinNotice),
      },
      options,
    );
    return 0;
  }
}

// The note for hook input that is not JSON. The hook cannot tell what sent it, so it names both
// hook files and the commands that check the wiring and the change.
const INVALID_INPUT_MESSAGE =
  'NOT verified - the stop hook got input it could not read, so the stop went through and nothing was checked on this stop. ' +
  'Next: check the hook command in .claude/settings.json or .cursor/hooks.json, run usabl doctor, ' +
  'and run usabl check before you call this change accessible.';

export async function runStopHookFromStdin(
  stdinText: string,
  // The default is the stop-hook command's own ports, with the deadline on.
  ports: StopHookRunnerPorts = makeStopHookRunnerPorts({ deadline: true }),
  options: StopHookOptions = DEFAULT_OPTIONS,
): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(stdinText);
    // Cursor sends a different stdin shape (status, loop_count) than Claude (stop_hook_active, session_id).
    const input = options.cursorMode ? parseCursorStopInput(parsed) : parseStopHookInput(parsed);
    return runStopHook(input, ports, options);
  } catch {
    await emitProtocolAllow(ports, { message: INVALID_INPUT_MESSAGE }, options);
    return 0;
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

export async function main(): Promise<number> {
  const cursorMode = process.argv.includes('--cursor');
  return runStopHookFromStdin(await readStdin(), makeStopHookRunnerPorts({ deadline: true }), { cursorMode });
}
