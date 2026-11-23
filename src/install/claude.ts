/**
 * Claude settings install generator for `usabl install --claude`.
 * It wires a Stop hook that runs `npm exec --no -- usabl stop-hook`, with a `timeout` and the
 * same limit passed to the runner, so usabl answers before Claude Code ends the hook. settings.json is
 * JSON, so this parses and merges: it adds the usabl Stop hook, preserves unrelated
 * hooks, and updates a usabl-owned hook still wired to the retired raw dist path. It
 * refuses when the file is unparseable or when a Stop hook it cannot recognize is
 * present, rather than risk a double-run or clobbering an operator's own hook.
 */
import { CLAUDE_STOP_TIMEOUT_SECONDS, MIN_HOST_TIMEOUT_SECONDS, parseTimeoutSeconds, STOP_HOOK_TIMEOUT_ENV } from '../surfaces/stop-hook-deadline.js';
import type { InstallFs, InstallResult } from './index.js';
import { LEGACY_USABL_RUN, USABL_NOT_INSTALLED_LINE, USABL_RUN } from './usabl-command.js';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

// The command in the words a person reads in a message. The hook itself is STOP_HOOK_COMMAND.
export const STOP_HOOK_DISPLAY = `${USABL_RUN} stop-hook`;

// Everything in the Stop hook command after the time limit. Claude Code runs it with sh -c. npm
// exec --no runs the usabl installed in the project (package.json bin: usabl -> dist/cli.js), or a
// global one, and never downloads a package. npm's own error output is silenced, so when usabl
// cannot run, the first and only line on stderr is the plain one below, and the exit code is 1.
// Claude Code treats exit 1 as a hook error that does not block: the stop goes on and the user
// sees that line. Exit 2 would block, and a person could not clear it without installing usabl.
// usabl's own stop-hook command always exits 0, so the fallback runs only when usabl did not run.
const STOP_HOOK_RUN = `npm_config_loglevel=silent ${STOP_HOOK_DISPLAY} || { echo "${USABL_NOT_INSTALLED_LINE}" >&2; exit 1; }`;

/**
 * The Stop hook command for a time limit in seconds. The command sets USABL_STOP_HOOK_TIMEOUT to
 * the same number as the hook's `timeout`, and the runner plans its own deadline to it (see
 * stop-hook-deadline.ts). An environment variable, not a flag, so a usabl older than the command
 * ignores it instead of refusing an unknown flag.
 */
export function stopHookCommand(seconds: number): string {
  return `${STOP_HOOK_TIMEOUT_ENV}=${seconds} ${STOP_HOOK_RUN}`;
}

// The Stop hook command usabl writes.
export const STOP_HOOK_COMMAND = stopHookCommand(CLAUDE_STOP_TIMEOUT_SECONDS);

// The command the previous release wrote. It sets no limit, and its hook had no timeout, so the
// runner cannot know Claude Code's limit. It is usabl's own, so a reinstall rewrites it.
export const PREVIOUS_STOP_HOOK_COMMAND = STOP_HOOK_RUN;

// The command earlier releases wrote. It is usabl's own, so a reinstall rewrites it, and doctor
// reports it as a security drift: npx downloads whatever holds the name usabl when it is missing.
export const LEGACY_STOP_HOOK_COMMAND = `${LEGACY_USABL_RUN} stop-hook`;

// Why an update is needed. A read-only caller (doctor) needs to tell two cases apart that
// planClaude otherwise collapses into one "update": a settings file that simply lacks the
// usabl Stop hook (add-missing, which for doctor is a missing surface) from one whose usabl
// hook is present but not the stable command (normalize, which for doctor is a drifted
// surface). writeClaude does not branch on this; it exists so recognition of the two cases
// stays here, next to classifyStop, rather than being re-derived inside doctor. remove-download is
// the normalize case where the usabl hook is the old npx form, which doctor reports as a security
// drift. timeout is a usabl hook whose time limit usabl cannot plan to; timeoutProblem says why.
export type UpdateReason = 'add-missing' | 'normalize' | 'remove-download' | 'timeout';

/**
 * Why usabl cannot plan to a usabl Stop hook's time limit.
 *   missing: the hook has no `timeout` that is a number.
 *   below-minimum: the timeout, or the limit in the command, is below the runner's minimum.
 *   mismatch: the command sets no limit, or one that differs from the timeout.
 */
export type TimeoutProblem = 'missing' | 'below-minimum' | 'mismatch';

export type ClaudePlan =
  | { action: 'write'; path: string; contents: string }
  | { action: 'update'; path: string; contents: string; reason: UpdateReason; timeoutProblem?: TimeoutProblem }
  | { action: 'already-wired'; path: string }
  | { action: 'refuse'; path: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUsablStopCommand(command: string): boolean {
  // Recognition is exact and anchored, never a substring match. A command is usabl-owned
  // only when the whole trimmed command is one of the forms usabl itself emits or shipped.
  // Anything that merely contains the marker (an env prefix, a redirect, a pipe, extra
  // args, or a foreign command that mentions it as data) is an operator customization we
  // must not silently rewrite, so it falls through to the refusal path instead.
  const trimmed = command.trim();
  if (
    stopHookCommandLimit(trimmed) !== null ||
    trimmed === PREVIOUS_STOP_HOOK_COMMAND ||
    trimmed === LEGACY_STOP_HOOK_COMMAND ||
    trimmed === 'usabl stop-hook'
  ) {
    return true;
  }
  // A plain node invocation of the retired dist runner and nothing else: no wrappers, env
  // prefixes, redirects, pipes, subshells, or trailing arguments. Two constraints keep this a
  // recognizer and not an injection surface, since a match authorizes a silent rewrite:
  //   - The path prefix, if present, must end at a segment boundary, so "usabl" is the whole
  //     final directory before /dist, not a suffix of one. Without the trailing slash on the
  //     prefix group, "notusabl/dist/..." matches and a foreign "*usabl" directory reads as
  //     usabl-owned.
  //   - The prefix is an allowlist of literal POSIX path characters, not a blocklist of a few
  //     shell metacharacters. A blocklist cannot enumerate every expansion or comment form:
  //     "$PATH", backticks, "#", backslashes, and globs would all slip through and let a
  //     foreign command with shell syntax read as usabl-owned. Only path characters are
  //     accepted, so anything that could be shell syntax fails closed. "+" is on the allowlist
  //     because pnpm's virtual store encodes path separators as "+" and real directories carry
  //     it (a "c++-ui" folder), and it is not shell-expandable, so excluding it would refuse a
  //     legitimate usabl hook rather than migrate it.
  // The first path character cannot be "-": node reads a leading-dash argument as an option, not
  // a script path, so "node -x/usabl/dist/..." is not actually running the retired runner and
  // must not be rewritten as if it were.
  // The separator is [ \t]+, not \s+, so a command-separating newline cannot join "node" to a
  // following retired-path token.
  return /^node[ \t]+(?!-)([A-Za-z0-9._@+/-]*\/)?usabl\/dist\/stop-hook-runner\.js$/.test(trimmed);
}

/**
 * The limit a Stop hook command of the form stopHookCommand writes sets, or null when the command
 * is not of that form. The number must be whole seconds as stopHookCommand prints them, so no shell
 * syntax can sit in its place.
 */
export function stopHookCommandLimit(command: string): number | null {
  const prefix = `${STOP_HOOK_TIMEOUT_ENV}=`;
  if (!command.startsWith(prefix)) {
    return null;
  }
  const rest = command.slice(prefix.length);
  const space = rest.indexOf(' ');
  if (space < 0 || rest.slice(space + 1) !== STOP_HOOK_RUN) {
    return null;
  }
  const text = rest.slice(0, space);
  const seconds = parseTimeoutSeconds(text);
  return seconds !== null && String(seconds) === text ? seconds : null;
}

/** Why usabl cannot plan to this usabl Stop hook's limit, or null when it can. */
export function stopHookTimeoutProblem(hook: Record<string, unknown>): TimeoutProblem | null {
  const command = typeof hook['command'] === 'string' ? hook['command'].trim() : '';
  const timeout = hook['timeout'];
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
    return 'missing';
  }
  const commandLimit = stopHookCommandLimit(command);
  if (timeout < MIN_HOST_TIMEOUT_SECONDS || (commandLimit !== null && commandLimit < MIN_HOST_TIMEOUT_SECONDS)) {
    return 'below-minimum';
  }
  return commandLimit === timeout ? null : 'mismatch';
}

// True for a limit usabl can write in both places: whole seconds the runner reads, at or above
// the minimum.
function usableLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_HOST_TIMEOUT_SECONDS &&
    parseTimeoutSeconds(String(value)) !== null
  );
}

/**
 * The limit a rewrite gives a usabl hook. The hook's `timeout` is the limit Claude Code enforces,
 * so a usable one is kept, lower or higher than the default, and the command is made to match it.
 * Without one, a usable limit in the command is kept. Otherwise the default.
 */
function rewriteLimit(hook: Record<string, unknown>): number {
  const timeout = hook['timeout'];
  if (usableLimit(timeout)) {
    return timeout;
  }
  const command = typeof hook['command'] === 'string' ? hook['command'].trim() : '';
  const commandLimit = stopHookCommandLimit(command);
  return usableLimit(commandLimit) ? commandLimit : CLAUDE_STOP_TIMEOUT_SECONDS;
}

function canonicalStopEntry(): { hooks: Array<{ type: string; command: string; timeout: number }> } {
  return { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: CLAUDE_STOP_TIMEOUT_SECONDS }] };
}

function canonicalSettings(): { hooks: { Stop: Array<ReturnType<typeof canonicalStopEntry>> } } {
  return { hooks: { Stop: [canonicalStopEntry()] } };
}

function draftContents(): string {
  return `${JSON.stringify(canonicalSettings(), null, 2)}\n`;
}

function manualStep(): string {
  return [
    'Add this Stop hook to the file by hand:',
    `  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": ${JSON.stringify(STOP_HOOK_COMMAND)}, "timeout": ${CLAUDE_STOP_TIMEOUT_SECONDS} } ] } ] }`,
  ].join('\n');
}

// True when a usabl-owned Stop command is the old npx form.
function hasLegacyCommand(stop: unknown[]): boolean {
  return stop.some(
    (entry) =>
      isRecord(entry) &&
      Array.isArray(entry['hooks']) &&
      entry['hooks'].some(
        (hook) => isRecord(hook) && typeof hook['command'] === 'string' && hook['command'].trim() === LEGACY_STOP_HOOK_COMMAND,
      ),
  );
}

function refuse(reason: string): ClaudePlan {
  return { action: 'refuse', path: CLAUDE_SETTINGS_PATH, reason: `${reason}\n${manualStep()}` };
}

// Read the Stop hooks and split their command entries into usabl-owned and everything
// else. Anything under Stop that is not a usabl-owned command (a foreign command, or a
// non-command hook we do not understand) counts as "other" and makes ownership ambiguous.
function classifyStop(stop: unknown[]): { usabl: number; other: number } | null {
  let usabl = 0;
  let other = 0;
  for (const entry of stop) {
    if (!isRecord(entry)) {
      return null;
    }
    const entryHooks = entry['hooks'];
    if (entryHooks === undefined) {
      continue;
    }
    if (!Array.isArray(entryHooks)) {
      return null;
    }
    for (const hook of entryHooks) {
      if (!isRecord(hook)) {
        return null;
      }
      const command = hook['command'];
      if (hook['type'] === 'command' && typeof command === 'string' && isUsablStopCommand(command)) {
        usabl += 1;
      } else {
        other += 1;
      }
    }
  }
  return { usabl, other };
}

// The usabl-owned Stop hooks, in order.
function usablHooks(stop: unknown[]): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const entry of stop) {
    if (!isRecord(entry) || !Array.isArray(entry['hooks'])) {
      continue;
    }
    for (const hook of entry['hooks']) {
      if (isRecord(hook) && hook['type'] === 'command' && typeof hook['command'] === 'string' && isUsablStopCommand(hook['command'])) {
        found.push(hook);
      }
    }
  }
  return found;
}

// Rewrite every usabl-owned Stop hook in place to the stable command and a matching timeout,
// leaving all other keys, matchers, and hook entries exactly as they were.
function rewriteUsablCommands(stop: unknown[]): void {
  for (const hook of usablHooks(stop)) {
    const seconds = rewriteLimit(hook);
    hook['command'] = stopHookCommand(seconds);
    hook['timeout'] = seconds;
  }
}

// True when a usabl hook runs a command of the current form or the previous one, so the only
// thing to change is its time limit.
function isCurrentOrPreviousCommand(hook: Record<string, unknown>): boolean {
  const command = typeof hook['command'] === 'string' ? hook['command'].trim() : '';
  return stopHookCommandLimit(command) !== null || command === PREVIOUS_STOP_HOOK_COMMAND;
}

export async function planClaude(fs: InstallFs): Promise<ClaudePlan> {
  const raw = await fs.readFile(CLAUDE_SETTINGS_PATH);
  if (raw === null) {
    return { action: 'write', path: CLAUDE_SETTINGS_PATH, contents: draftContents() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse(`Refusing to merge into ${CLAUDE_SETTINGS_PATH}: it is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    return refuse(`Refusing to merge into ${CLAUDE_SETTINGS_PATH}: its top level is not a JSON object.`);
  }

  const hooks = parsed['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) {
    return refuse(`Refusing to merge into ${CLAUDE_SETTINGS_PATH}: "hooks" is not a JSON object.`);
  }
  const stop = isRecord(hooks) ? hooks['Stop'] : undefined;
  if (stop !== undefined && !Array.isArray(stop)) {
    return refuse(`Refusing to merge into ${CLAUDE_SETTINGS_PATH}: "hooks.Stop" is not a JSON array.`);
  }

  const counts = Array.isArray(stop) ? classifyStop(stop) : { usabl: 0, other: 0 };
  if (counts === null) {
    return refuse(`Refusing to merge into ${CLAUDE_SETTINGS_PATH}: its Stop hook shape is not one usabl can safely edit.`);
  }
  if (counts.other > 0) {
    return refuse(
      `Refusing to change ${CLAUDE_SETTINGS_PATH}: it already has a Stop hook usabl does not recognize. Two Stop hooks would both run.`,
    );
  }
  if (counts.usabl > 1) {
    // Collapsing several usabl Stop entries to one could silently drop a differing matcher
    // or other fields, and leaving them reports already-wired while two hooks both run.
    // Refusing with a manual step is the honest, safe call.
    return refuse(
      `Refusing to change ${CLAUDE_SETTINGS_PATH}: it has more than one usabl Stop hook, and two would both run. Reconcile them to a single usabl Stop hook by hand.`,
    );
  }

  // Build the merged object without touching the original, so a refusal path never leaves
  // a half-written file. Only non-Stop content and usabl-owned commands are affected.
  const updated = structuredClone(parsed) as Record<string, unknown>;
  const updatedHooks = isRecord(updated['hooks']) ? (updated['hooks'] as Record<string, unknown>) : {};
  updated['hooks'] = updatedHooks;
  const updatedStop = Array.isArray(updatedHooks['Stop']) ? (updatedHooks['Stop'] as unknown[]) : [];
  updatedHooks['Stop'] = updatedStop;
  // A usabl hook already present means the only change is to normalize its command. No usabl
  // hook present means we are adding the missing hook. Capture that here, before the mutation,
  // so an update carries an honest reason for read-only callers.
  const owned = usablHooks(updatedStop)[0];
  const timeoutProblem = owned !== undefined && isCurrentOrPreviousCommand(owned) ? stopHookTimeoutProblem(owned) : null;
  const reason: UpdateReason =
    counts.usabl === 0
      ? 'add-missing'
      : hasLegacyCommand(updatedStop)
        ? 'remove-download'
        : timeoutProblem !== null
          ? 'timeout'
          : 'normalize';
  if (counts.usabl > 0) {
    rewriteUsablCommands(updatedStop);
  } else {
    updatedStop.push(canonicalStopEntry());
  }

  // Idempotence check: if the merge changes nothing, the hook is already wired.
  if (JSON.stringify(updated) === JSON.stringify(parsed)) {
    return { action: 'already-wired', path: CLAUDE_SETTINGS_PATH };
  }
  return {
    action: 'update',
    path: CLAUDE_SETTINGS_PATH,
    contents: `${JSON.stringify(updated, null, 2)}\n`,
    reason,
    ...(reason === 'timeout' && timeoutProblem !== null ? { timeoutProblem } : {}),
  };
}

// What the hook's time limit is for, in the words an install message ends with.
function limitNote(contents: string): string {
  let seconds = CLAUDE_STOP_TIMEOUT_SECONDS;
  try {
    const parsed: unknown = JSON.parse(contents);
    const stop = isRecord(parsed) && isRecord(parsed['hooks']) ? parsed['hooks']['Stop'] : undefined;
    const hook = Array.isArray(stop) ? usablHooks(stop)[0] : undefined;
    if (hook !== undefined && typeof hook['timeout'] === 'number') {
      seconds = hook['timeout'];
    }
  } catch {
    // The plan wrote these contents, so they parse. The default is the fallback all the same.
  }
  return (
    ` The hook's timeout is ${seconds} seconds, and ${STOP_HOOK_TIMEOUT_ENV} in its command matches it, ` +
    'so usabl answers before Claude Code ends the hook.'
  );
}

export async function writeClaude(fs: InstallFs, plan: ClaudePlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    // The file did not exist, so this is a fresh draft the operator can review whole.
    await fs.writeFile(plan.path, plan.contents);
    return {
      exitCode: 0,
      action: 'written',
      path: plan.path,
      message: `Wrote ${plan.path} to run the usabl Stop hook (${STOP_HOOK_DISPLAY}).${limitNote(plan.contents)} Review this file before you commit it.`,
    };
  }
  if (plan.action === 'update') {
    // This lands directly on the live .claude/settings.json that Claude Code reads, so the
    // message says the live file changed and points at the diff rather than calling it a draft.
    await fs.writeFile(plan.path, plan.contents);
    const why =
      plan.reason === 'remove-download'
        ? ` The old hook ran "${LEGACY_STOP_HOOK_COMMAND}", which downloads a package when usabl is not installed. The new one never downloads.`
        : '';
    return {
      exitCode: 0,
      action: 'written',
      path: plan.path,
      message: `Updated the live ${plan.path} to run the usabl Stop hook (${STOP_HOOK_DISPLAY}).${why}${limitNote(plan.contents)} Review the diff before you commit it.`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: plan.path,
      message: `${plan.path} already runs the usabl Stop hook (${STOP_HOOK_DISPLAY}). No change.`,
    };
  }
  return { exitCode: 2, action: 'refused', path: plan.path, message: plan.reason };
}
