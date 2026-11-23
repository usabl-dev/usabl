/**
 * The Stop hook's own time limit.
 *
 * An assistant ends a hook that runs past its time limit, and a hook it ends is not a block: the
 * stop goes on. So a slow stop would let an agent stop without the accessibility work. The runner
 * therefore keeps a deadline of its own, shorter than the host's limit. When the deadline comes
 * first, the runner stops the check, saves no receipt, and blocks once with the message below.
 *
 * Only one answer reaches the host. The checks claim the answer with their first write of it (the
 * receipt, or a line of output), and the deadline claims it when it comes first. When the checks
 * claimed it, the deadline waits a short time for them to finish it and writes nothing.
 *
 * The host's limit reaches the runner through the USABL_STOP_HOOK_TIMEOUT environment variable,
 * which the generated Claude Code hook command sets to the same number as the hook's `timeout`.
 * When the variable is unset or unusable, the runner plans to the host's own default: the timeout
 * usabl install --cursor writes for Cursor, and Claude Code's default for a command hook for
 * Claude. This module only computes numbers and fixed text. It decides no verdict.
 */

/** The environment variable that carries the host's limit, in whole seconds. */
export const STOP_HOOK_TIMEOUT_ENV = 'USABL_STOP_HOOK_TIMEOUT';

/** The `timeout` usabl install --claude writes for the Stop hook, in seconds. */
export const CLAUDE_STOP_TIMEOUT_SECONDS = 600;

/** The `timeout` usabl install --cursor writes in .cursor/hooks.json, in seconds. */
export const CURSOR_STOP_TIMEOUT_SECONDS = 300;

/**
 * The limit the runner plans to for a Claude Code hook command that sets no limit, in seconds. The
 * hook an older usabl wrote is one. Claude Code's hooks documentation gives 600 seconds as the
 * default for a command hook with no `timeout` field, and the Stop event keeps that default.
 * Limit: an older Claude Code release whose default was 60 seconds can end such a hook before usabl
 * answers, as it could before usabl kept a deadline, until usabl install --claude runs again.
 */
export const CLAUDE_DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

/**
 * The time left between the runner's deadline and the host's limit, in seconds. It covers npm
 * starting the hook before the runner's clock starts, finishing or writing the answer
 * (ANSWER_FINISH_WAIT_MS), closing the browser (BROWSER_CLOSE_WAIT_MS), and the process exit.
 */
export const ANSWER_MARGIN_SECONDS = 30;

/**
 * The smallest host limit that leaves the full margin and at least as much time to check. Below
 * it the runner keeps half the limit for itself, and usabl doctor reports the hook.
 */
export const MIN_HOST_TIMEOUT_SECONDS = 60;

/** How long the runner waits for the browser to close after the deadline, in milliseconds. */
export const BROWSER_CLOSE_WAIT_MS = 10_000;

/**
 * How long the runner waits, after the deadline, for a check that had already started writing its
 * own answer to finish it, in milliseconds. Only one answer may reach the host, so the deadline
 * does not write a second one.
 */
export const ANSWER_FINISH_WAIT_MS = 10_000;

// Whole seconds, at most six digits. A larger number is no limit usabl can plan to.
const SECONDS_PATTERN = /^[1-9][0-9]{0,5}$/;

/** Where the host limit came from. Each source has its own words in the message. */
export type HostLimitSource = 'hook' | 'claude-default' | 'cursor-install';

export interface HostLimit {
  seconds: number;
  source: HostLimitSource;
  // True when USABL_STOP_HOOK_TIMEOUT was set to a value usabl cannot use, so it was ignored.
  ignored: boolean;
}

/** The value as whole seconds, or null when it is not one usabl can plan to. */
export function parseTimeoutSeconds(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return SECONDS_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

/** The host's limit for this stop. */
export function hostLimit(setting: string | undefined, cursorMode: boolean): HostLimit {
  const seconds = parseTimeoutSeconds(setting);
  if (seconds !== null) {
    return { seconds, source: 'hook', ignored: false };
  }
  const ignored = setting !== undefined;
  return cursorMode
    ? { seconds: CURSOR_STOP_TIMEOUT_SECONDS, source: 'cursor-install', ignored }
    : { seconds: CLAUDE_DEFAULT_HOOK_TIMEOUT_SECONDS, source: 'claude-default', ignored };
}

/** The runner's own deadline for a host limit, in seconds. */
export function runnerDeadlineSeconds(hostSeconds: number): number {
  if (hostSeconds >= MIN_HOST_TIMEOUT_SECONDS) {
    return hostSeconds - ANSWER_MARGIN_SECONDS;
  }
  return Math.max(1, Math.floor(hostSeconds / 2));
}

/**
 * How long each wait after the deadline may last, in milliseconds: the answer a check was writing,
 * and the browser close. Each gets a third of the time between the deadline and the host's limit,
 * and never more than its fixed bound, so both waits together end before the limit with a third
 * left for npm starting the hook and the exit. With the full 30 second margin each keeps its
 * fixed bound.
 */
export function afterDeadlineWaitMs(hostSeconds: number, fixedMs: number): number {
  const marginMs = (hostSeconds - runnerDeadlineSeconds(hostSeconds)) * 1000;
  return Math.min(fixedMs, Math.floor(marginMs / 3));
}

/** A timer the runner races its work against. */
export interface StopTimer {
  expired: Promise<void>;
  cancel(): void;
}

/** What the runner needs to keep its deadline. The real one is in makeStopHookRunnerPorts. */
export interface StopHookDeadlinePort {
  // The USABL_STOP_HOOK_TIMEOUT value, or undefined when the hook command sets none.
  timeoutSetting: string | undefined;
  // How long the hook process ran before the runner started, in milliseconds.
  elapsedMs: () => number;
  // A timer that ends after `ms` milliseconds from now.
  startTimer: (ms: number) => StopTimer;
  // Ends the process once the answer is written, so work still running cannot hold it past the
  // host's limit. The host reads the answer only when the process exits.
  endProcess: () => Promise<void>;
}

// Why usabl did not use USABL_STOP_HOOK_TIMEOUT. The value is not printed: it comes from the
// environment, and the reason is enough to fix it.
function unusedSettingReason(limit: HostLimit, unsetWords: string): string {
  return limit.ignored
    ? `because ${STOP_HOOK_TIMEOUT_ENV} was set to a value that is not a whole number of seconds from 1 to 999999, so usabl ignored it`
    : unsetWords;
}

function limitSource(limit: HostLimit): string {
  if (limit.source === 'hook') {
    return `set by ${STOP_HOOK_TIMEOUT_ENV}`;
  }
  if (limit.source === 'cursor-install') {
    return (
      'the timeout usabl install --cursor writes in .cursor/hooks.json, ' +
      unusedSettingReason(limit, `because .cursor/hooks/usabl-stop.sh passes no ${STOP_HOOK_TIMEOUT_ENV}`)
    );
  }
  return `Claude Code's default, ${unusedSettingReason(limit, `because the hook command sets no ${STOP_HOOK_TIMEOUT_ENV}`)}`;
}

function raiseStep(cursorMode: boolean): string {
  if (cursorMode) {
    return (
      'To raise the limit, set the usabl stop hook\'s "timeout" in .cursor/hooks.json, then run usabl install --cursor again, ' +
      'so .cursor/hooks/usabl-stop.sh passes the same number to usabl.'
    );
  }
  return (
    'To raise the limit, set the usabl Stop hook\'s "timeout" in .claude/settings.json and ' +
    `${STOP_HOOK_TIMEOUT_ENV} in its command to the same number of seconds, or run usabl install --claude to write both.`
  );
}

export interface DeadlineMessageInput {
  limit: HostLimit;
  cursorMode: boolean;
  continuation: boolean;
  // The check the advice names: usabl check, or usabl check --branch-scope.
  checkCommand: string;
}

/**
 * The message for a stop that reached the deadline. Every part is usabl's own text, so nothing in
 * it is framed.
 */
export function deadlineMessage(input: DeadlineMessageInput): string {
  const deadline = runnerDeadlineSeconds(input.limit.seconds);
  const lines = [
    `NOT verified - usabl ran out of time: this stop took longer than usabl's own limit of ${deadline} seconds, ` +
      'so usabl stopped the check before it could check the change. ' +
      'Nothing is proven about this change, and no receipt was saved.',
    `usabl's limit is the hook's limit of ${input.limit.seconds} seconds (${limitSource(input.limit)}), ` +
      `less ${input.limit.seconds - deadline} seconds to answer before the assistant ends the hook.`,
  ];
  if (input.continuation) {
    lines.push('usabl let this stop through without blocking again (continuation already active).');
  }
  lines.push(
    `Next: narrow the change and stop again, or run ${input.checkCommand} by hand, or raise the limit in the hook settings. ` +
      raiseStep(input.cursorMode),
  );
  if (input.limit.source === 'claude-default') {
    // The hook states no limit, so usabl planned to Claude Code's default.
    lines.push('Run usabl install --claude again so the hook states its time limit.');
  }
  return lines.join('\n');
}
