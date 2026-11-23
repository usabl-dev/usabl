/**
 * Cursor assistant install generator for `usabl install --cursor`.
 * It writes four files: the stop hook (hooks.json + adapter script) that blocks the agent
 * on regression via Cursor's followup_message protocol, the /usabl-check slash command for
 * advisory mid-task scans, and a UI-scoped rule that reminds the agent to self-check.
 * Each path is a whole-file draft: absent, write; identical, no-op; different, refuse.
 * The paths are usabl-owned, but a differing file may be an operator edit or an older
 * engine version, so the generator refuses rather than clobber it.
 */
import { parseUsablConfig } from '../intake/config.js';
import { CURSOR_STOP_TIMEOUT_SECONDS, STOP_HOOK_TIMEOUT_ENV } from '../surfaces/stop-hook-deadline.js';
import type { InstallFs, InstallResult } from './index.js';
import { LEGACY_USABL_RUN, USABL_MISSING_GUIDANCE, USABL_NOT_INSTALLED_LINE, USABL_RUN } from './usabl-command.js';

export const CURSOR_HOOKS_JSON_PATH = '.cursor/hooks.json';
export const CURSOR_STOP_SCRIPT_PATH = '.cursor/hooks/usabl-stop.sh';
export const CURSOR_COMMAND_PATH = '.cursor/commands/usabl-check.md';
export const CURSOR_RULE_PATH = '.cursor/rules/usabl-accessibility.mdc';

// Used when usabl.config.json is absent, unreadable, or has no uiFileGlobs.
export const DEFAULT_CURSOR_UI_FILE_GLOBS = ['src/**'];

// The stop hook loops the agent until the gate is green. A limit prevents infinite loops
// when the developer cannot resolve the findings in the current session.
const STOP_LOOP_LIMIT = 3;

// The canonical stop script. It pipes Cursor's stdin (with status and loop_count) through
// `npm exec --no -- usabl stop-hook --cursor`, which emits the Cursor-native followup_message
// protocol. npm's own error output is silenced, so when usabl cannot run the only stderr line is
// the plain one. The exit code is then 1, never 2, because Cursor reads 2 as a block.
// All gate logic stays inside the engine's stop-hook runner; this script is a thin adapter.
// The script passes the stop entry's own timeout to usabl in USABL_STOP_HOOK_TIMEOUT, so usabl
// plans its deadline to the limit Cursor enforces, and a value in the environment Cursor runs in
// cannot put the deadline past it (see stop-hook-deadline.ts).
export function cursorStopScript(seconds: number): string {
  return `#!/usr/bin/env bash
# Cursor stop hook adapter for usabl.
# Pipes Cursor's stdin through the engine and emits followup_message to loop on block.
# It runs the usabl installed in this project with npm exec --no, which never downloads a package.
# When usabl cannot run, it prints one line on stderr and exits 1. Cursor treats an exit other
# than 0 and 2 as a failed hook and lets the agent finish. Nothing was checked on that stop.
# USABL_STOP_HOOK_TIMEOUT is the usabl stop hook's timeout in .cursor/hooks.json, so usabl answers
# before Cursor ends the hook. "usabl install --cursor" keeps the two the same.
# This script is managed by "usabl install --cursor". Manual edits will be detected.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if ! cat | ${STOP_HOOK_TIMEOUT_ENV}=${seconds} npm_config_loglevel=silent ${USABL_RUN} stop-hook --cursor; then
  echo "${USABL_NOT_INSTALLED_LINE}" >&2
  exit 1
fi
`;
}

export const CURSOR_STOP_SCRIPT = cursorStopScript(CURSOR_STOP_TIMEOUT_SECONDS);

// The script the previous release wrote, byte for byte. It passed no limit to usabl, so usabl
// planned to 300 seconds whatever hooks.json said, and a value in the environment could win. It is
// usabl's own, so a reinstall rewrites it, and doctor reports it as drifted.
export const PREVIOUS_CURSOR_STOP_SCRIPT = `#!/usr/bin/env bash
# Cursor stop hook adapter for usabl.
# Pipes Cursor's stdin through the engine and emits followup_message to loop on block.
# It runs the usabl installed in this project with npm exec --no, which never downloads a package.
# When usabl cannot run, it prints one line on stderr and exits 1. Cursor treats an exit other
# than 0 and 2 as a failed hook and lets the agent finish. Nothing was checked on that stop.
# This script is managed by "usabl install --cursor". Manual edits will be detected.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if ! cat | npm_config_loglevel=silent ${USABL_RUN} stop-hook --cursor; then
  echo "${USABL_NOT_INSTALLED_LINE}" >&2
  exit 1
fi
`;

/**
 * The limit a script of the form cursorStopScript writes passes to usabl, or null when the script
 * is not of that form. The whole script must match, so no edit can sit beside the number.
 */
export function cursorStopScriptLimit(script: string): number | null {
  const found = new RegExp(`${STOP_HOOK_TIMEOUT_ENV}=([1-9][0-9]{0,5}) `).exec(script);
  if (found === null) {
    return null;
  }
  const seconds = Number(found[1]);
  return script === cursorStopScript(seconds) ? seconds : null;
}

// The hooks.json content. Written as a string so byte-identical comparison works for
// idempotence, the same way the other install drafts work.
// The timeout is Cursor's limit for the hook. The adapter script passes the same number to the
// runner, which plans its own deadline to it (see stop-hook-deadline.ts).
export function buildCursorHooksJson(existingHooks: Record<string, unknown> | null): string {
  const stopEntry = {
    command: '.cursor/hooks/usabl-stop.sh',
    timeout: CURSOR_STOP_TIMEOUT_SECONDS,
    loop_limit: STOP_LOOP_LIMIT,
  };

  if (existingHooks === null) {
    return JSON.stringify({ version: 1, hooks: { stop: [stopEntry] } }, null, 2) + '\n';
  }

  // Merge into existing hooks object, preserving unrelated events.
  const merged = { ...existingHooks, stop: [stopEntry] };
  return JSON.stringify({ version: 1, hooks: merged }, null, 2) + '\n';
}

export const CURSOR_COMMAND_CONTENTS = `# usabl-check

Run \`${USABL_RUN} check --self-check\` from the repository root.

${USABL_MISSING_GUIDANCE}

Report:

1. The verdict.
2. The affected accessibility behavior.
3. The first finding and suggested repair, when present.
4. Any missing coverage.

This is an on-demand self-check the assistant runs during implementation. It is
advisory. Do not call the work verified from this command alone. The accessibility
gate (\`usabl check\` / CI) decides proof.
`;

export function resolveCursorUiFileGlobs(uiFileGlobs: string[]): string[] {
  return uiFileGlobs.length > 0 ? uiFileGlobs : DEFAULT_CURSOR_UI_FILE_GLOBS;
}

export async function readCursorUiFileGlobs(fs: InstallFs, configPath: string): Promise<string[]> {
  const raw = await fs.readFile(configPath);
  if (raw === null) {
    return DEFAULT_CURSOR_UI_FILE_GLOBS;
  }
  try {
    return resolveCursorUiFileGlobs(parseUsablConfig(raw).uiFileGlobs);
  } catch {
    return DEFAULT_CURSOR_UI_FILE_GLOBS;
  }
}

// Derive Cursor rule globs from usabl.config.json uiFileGlobs so the rule attaches to the UI
// tree the gate already tracks, not a hardcoded src/ layout.
export function cursorRuleGlobs(uiFileGlobs: string[]): string {
  const sources = resolveCursorUiFileGlobs(uiFileGlobs);
  return sources
    .map((glob) => {
      if (glob.includes('{')) {
        return glob;
      }
      // A last segment with a dot names a file or a file pattern, so it already selects files.
      // Appending an extension pattern would treat that file as a directory and match nothing,
      // which silently drops UI the config declared.
      const lastSegment = glob.slice(glob.lastIndexOf('/') + 1);
      if (lastSegment.includes('.')) {
        return glob;
      }
      if (glob.endsWith('/**')) {
        return `${glob}/*.{tsx,jsx,css}`;
      }
      if (glob.endsWith('/*')) {
        return `${glob.slice(0, -2)}/**/*.{tsx,jsx,css}`;
      }
      return `${glob}/**/*.{tsx,jsx,css}`;
    })
    .join(',');
}

export function buildCursorRuleContents(uiFileGlobs: string[]): string {
  return `---
description: Run usabl accessibility self-checks while editing UI and before claiming work is done
globs: ${cursorRuleGlobs(uiFileGlobs)}
alwaysApply: false
---

# usabl accessibility workflow

Before you start a task, run \`${USABL_RUN} brief --json --files <paths>\` from the repository root, with the paths of the files the task will edit. Keep the screens it says the task reaches and its \`done\` list in view while you work. The brief is a plan. Only the gate decides a verdict.

When changing user interface code:

- After a meaningful UI change, run \`/usabl-check\` or \`${USABL_RUN} check --self-check\` from the repository root.
- ${USABL_MISSING_GUIDANCE}
- Treat usabl findings as the source of truth for machine-checkable accessibility barriers.
- Explain verdicts honestly: \`verified\`, \`regression\`, \`not_covered\`, or \`approval_required\`.
- Do not call work verified from the self-check alone. The gate (\`usabl check\` / CI) decides proof.
- Prefer fixing source over query-parameter previews or disabling checks.
`;
}

export const CURSOR_RULE_CONTENTS = buildCursorRuleContents(DEFAULT_CURSOR_UI_FILE_GLOBS);

// The files the previous release wrote, byte for byte. They ran "npx usabl", which downloads a
// package when usabl is not installed. A file that holds exactly these bytes is usabl's own, so a
// reinstall rewrites it and doctor reports it as a security drift. Any other difference is still
// refused.
const LEGACY_CURSOR_STOP_SCRIPT = `#!/usr/bin/env bash
# Cursor stop hook adapter for usabl.
# Pipes Cursor's stdin through the engine and emits followup_message to loop on block.
# This script is managed by "usabl install --cursor". Manual edits will be detected.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

cat | npx usabl stop-hook --cursor
`;

const LEGACY_CURSOR_COMMAND_CONTENTS = `# usabl-check

Run \`npx usabl check --self-check\` from the repository root.

Report:

1. The verdict.
2. The affected accessibility behavior.
3. The first finding and suggested repair, when present.
4. Any missing coverage.

This is an on-demand self-check the assistant runs during implementation. It is
advisory. Do not call the work verified from this command alone. The accessibility
gate (\`usabl check\` / CI) decides proof.
`;

function buildLegacyCursorRuleContents(uiFileGlobs: string[]): string {
  return `---
description: Run usabl accessibility self-checks while editing UI and before claiming work is done
globs: ${cursorRuleGlobs(uiFileGlobs)}
alwaysApply: false
---

# usabl accessibility workflow

Before you start a task, run \`npx usabl brief --json --files <paths>\` from the repository root, with the paths of the files the task will edit. Keep the screens it says the task reaches and its \`done\` list in view while you work. The brief is a plan. Only the gate decides a verdict.

When changing user interface code:

- After a meaningful UI change, run \`/usabl-check\` or \`npx usabl check --self-check\` from the repository root.
- Treat usabl findings as the source of truth for machine-checkable barriers.
- Explain verdicts honestly: \`verified\`, \`regression\`, \`not_covered\`, or \`approval_required\`.
- Do not call work verified from the self-check alone. The gate (\`usabl check\` / CI) decides proof.
- Prefer fixing source over query-parameter previews or disabling checks.
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsablStopEntry(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const command = entry['command'];
  return typeof command === 'string' && command.trim() === '.cursor/hooks/usabl-stop.sh';
}

// Simple whole-file drafts (command and rule).
function simpleFiles(uiFileGlobs: string[]) {
  return [
    { path: CURSOR_COMMAND_PATH, draft: CURSOR_COMMAND_CONTENTS, legacy: LEGACY_CURSOR_COMMAND_CONTENTS },
    { path: CURSOR_RULE_PATH, draft: buildCursorRuleContents(uiFileGlobs), legacy: buildLegacyCursorRuleContents(uiFileGlobs) },
  ] as const;
}

/**
 * Why usabl cannot plan its deadline to the limit Cursor enforces for the usabl stop hook.
 *   missing: the stop entry has no timeout that is a number.
 *   below-limit: the stop entry's timeout is below 300 seconds.
 *   script-no-limit: the adapter script passes no limit to usabl (the previous release's script).
 *   script-mismatch: the adapter script passes a limit other than the stop entry's timeout.
 */
export type CursorTimeoutProblem = 'missing' | 'below-limit' | 'script-no-limit' | 'script-mismatch';

function cursorTimeoutProblem(entry: unknown): 'missing' | 'below-limit' | null {
  const timeout = isRecord(entry) ? entry['timeout'] : undefined;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
    return 'missing';
  }
  return timeout < CURSOR_STOP_TIMEOUT_SECONDS ? 'below-limit' : null;
}

// The largest limit usabl reads from USABL_STOP_HOOK_TIMEOUT: six digits of whole seconds.
const MAX_LIMIT_SECONDS = 999_999;

// The limit the adapter script passes for a stop entry timeout of at least 300 seconds: the
// timeout in whole seconds, never more than it and never more than usabl reads.
function scriptLimitFor(timeout: number): number {
  return Math.min(Math.floor(timeout), MAX_LIMIT_SECONDS);
}

// `rewrites` names the files written over an old npx form, which doctor reports as a security drift.
// `timeoutProblem` is set when hooks.json or the adapter script is written again to fix a limit.
export type CursorPlan =
  | {
      action: 'write';
      files: Array<{ path: string; draft: string }>;
      rewrites: string[];
      timeoutProblem?: CursorTimeoutProblem;
    }
  | { action: 'already-wired'; paths: string[] }
  | { action: 'refuse'; path: string; reason: string };

// Plan the hooks.json merge separately because it needs JSON-aware merging (preserving
// unrelated hooks), unlike the simple whole-file drafts for command and rule.
async function planHooksJson(
  fs: InstallFs,
): Promise<
  // `scriptLimit` is the limit the adapter script passes: the usabl stop entry's timeout as the
  // file will hold it.
  | { ok: true; action: 'write'; draft: string; scriptLimit: number; timeoutProblem?: CursorTimeoutProblem }
  | { ok: true; action: 'already-wired'; scriptLimit: number }
  | { ok: false; reason: string }
> {
  const existing = await fs.readFile(CURSOR_HOOKS_JSON_PATH);
  if (existing === null) {
    return { ok: true, action: 'write', draft: buildCursorHooksJson(null), scriptLimit: CURSOR_STOP_TIMEOUT_SECONDS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { ok: false, reason: `Refusing to merge into ${CURSOR_HOOKS_JSON_PATH}: it is not valid JSON.` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: `Refusing to merge into ${CURSOR_HOOKS_JSON_PATH}: its top level is not a JSON object.` };
  }

  const hooks = parsed['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) {
    return { ok: false, reason: `Refusing to merge into ${CURSOR_HOOKS_JSON_PATH}: "hooks" is not a JSON object.` };
  }

  const stop = isRecord(hooks) ? hooks['stop'] : undefined;
  if (stop !== undefined && !Array.isArray(stop)) {
    return { ok: false, reason: `Refusing to merge into ${CURSOR_HOOKS_JSON_PATH}: "hooks.stop" is not a JSON array.` };
  }

  if (Array.isArray(stop)) {
    let usablCount = 0;
    let otherCount = 0;
    for (const entry of stop) {
      if (isUsablStopEntry(entry)) {
        usablCount += 1;
      } else {
        otherCount += 1;
      }
    }
    if (otherCount > 0) {
      return {
        ok: false,
        reason: [
          `Refusing to change ${CURSOR_HOOKS_JSON_PATH}: it already has a stop hook usabl does not recognize.`,
          'Two stop hooks would both run. Reconcile by hand or remove the other hook first.',
        ].join('\n'),
      };
    }
    if (usablCount > 0) {
      // Every entry is usabl's own. One whose timeout is missing or below 300 seconds gets a
      // timeout of 300, and nothing else in the file changes: other keys of the entry (such as
      // loop_limit), other events, and other top-level keys stay as the person wrote them. A
      // higher timeout is kept, and the adapter script passes it to usabl.
      const updated = structuredClone(parsed);
      const updatedStop = (updated['hooks'] as Record<string, unknown>)['stop'] as unknown[];
      let problem: 'missing' | 'below-limit' | null = null;
      for (const entry of updatedStop) {
        const found = cursorTimeoutProblem(entry);
        if (found !== null && isRecord(entry)) {
          problem ??= found;
          entry['timeout'] = CURSOR_STOP_TIMEOUT_SECONDS;
        }
      }
      // Several usabl entries keep the smallest limit, so usabl ends before each of them.
      const scriptLimit = Math.min(
        ...updatedStop.map((entry) => scriptLimitFor((entry as Record<string, unknown>)['timeout'] as number)),
      );
      if (problem === null) {
        return { ok: true, action: 'already-wired', scriptLimit };
      }
      return { ok: true, action: 'write', draft: `${JSON.stringify(updated, null, 2)}\n`, scriptLimit, timeoutProblem: problem };
    }
  }

  // No usabl stop entry yet. It is added to a copy of the parsed file, as the timeout fix above
  // changes one, so every other top-level key, every other event, and the key order stay as the
  // person wrote them. A file with no version gets the version usabl writes.
  const merged = structuredClone(parsed);
  const canonical = JSON.parse(buildCursorHooksJson(null)) as { version: unknown; hooks: { stop: unknown[] } };
  merged['version'] ??= canonical.version;
  merged['hooks'] = { ...(isRecord(hooks) ? hooks : {}), stop: canonical.hooks.stop };
  return { ok: true, action: 'write', draft: `${JSON.stringify(merged, null, 2)}\n`, scriptLimit: CURSOR_STOP_TIMEOUT_SECONDS };
}

export async function planCursor(fs: InstallFs, uiFileGlobs: string[]): Promise<CursorPlan> {
  // Plan hooks.json (JSON-aware merge) and the stop script (whole-file).
  const hooksPlan = await planHooksJson(fs);
  if (!hooksPlan.ok) {
    return { action: 'refuse', path: CURSOR_HOOKS_JSON_PATH, reason: hooksPlan.reason };
  }

  const existingScript = await fs.readFile(CURSOR_STOP_SCRIPT_PATH);
  const scriptDraft = cursorStopScript(hooksPlan.scriptLimit);
  const scriptIsLegacy = existingScript === LEGACY_CURSOR_STOP_SCRIPT;
  const scriptIsPrevious = existingScript === PREVIOUS_CURSOR_STOP_SCRIPT;
  const scriptLimit = existingScript === null ? null : cursorStopScriptLimit(existingScript);
  // A script of the current form whose limit differs from the stop entry's timeout is usabl's
  // own, so a reinstall makes it match.
  const scriptProblem: CursorTimeoutProblem | undefined = scriptIsPrevious
    ? 'script-no-limit'
    : scriptLimit !== null && scriptLimit !== hooksPlan.scriptLimit
      ? 'script-mismatch'
      : undefined;
  if (existingScript !== null && scriptLimit === null && !scriptIsLegacy && !scriptIsPrevious) {
    return {
      action: 'refuse',
      path: CURSOR_STOP_SCRIPT_PATH,
      reason: [
        `Refusing to overwrite ${CURSOR_STOP_SCRIPT_PATH}: it exists but differs from the canonical usabl stop script.`,
        'If it is an older version, delete it and re-run "usabl install --cursor".',
        'If you edited it on purpose, keep your version.',
      ].join('\n'),
    };
  }

  // Plan the simple whole-file drafts (command and rule).
  const files = simpleFiles(uiFileGlobs);
  const existing: Array<{ path: string; draft: string; legacy: string; contents: string | null }> = [];
  for (const file of files) {
    existing.push({ ...file, contents: await fs.readFile(file.path) });
  }

  for (const file of existing) {
    if (file.contents !== null && file.contents !== file.draft && file.contents !== file.legacy) {
      return {
        action: 'refuse',
        path: file.path,
        reason: cursorRefusalMessage(file.path),
      };
    }
  }

  // Collect all files that need writing.
  const toWrite: Array<{ path: string; draft: string }> = [];
  const rewrites: string[] = [];
  if (hooksPlan.action === 'write') {
    toWrite.push({ path: CURSOR_HOOKS_JSON_PATH, draft: hooksPlan.draft });
  }
  if (existingScript !== scriptDraft) {
    toWrite.push({ path: CURSOR_STOP_SCRIPT_PATH, draft: scriptDraft });
    if (scriptIsLegacy) {
      rewrites.push(CURSOR_STOP_SCRIPT_PATH);
    }
  }
  for (const file of existing) {
    if (file.contents === null || file.contents === file.legacy) {
      toWrite.push({ path: file.path, draft: file.draft });
      if (file.contents !== null) {
        rewrites.push(file.path);
      }
    }
  }

  if (toWrite.length === 0) {
    const allPaths = [CURSOR_HOOKS_JSON_PATH, CURSOR_STOP_SCRIPT_PATH, ...files.map((f) => f.path)];
    return { action: 'already-wired', paths: allPaths };
  }

  const timeoutProblem = (hooksPlan.action === 'write' ? hooksPlan.timeoutProblem : undefined) ?? scriptProblem;
  return { action: 'write', files: toWrite, rewrites, ...(timeoutProblem === undefined ? {} : { timeoutProblem }) };
}

// What a reinstall changed to fix a limit, in the words its message ends with.
const CURSOR_TIMEOUT_NOTES: Record<CursorTimeoutProblem, string> = {
  missing:
    `Set the usabl stop hook's timeout in ${CURSOR_HOOKS_JSON_PATH} to ${CURSOR_STOP_TIMEOUT_SECONDS} seconds, ` +
    `and ${CURSOR_STOP_SCRIPT_PATH} passes the same limit to usabl, so usabl answers before Cursor ends the hook. ` +
    `Only the timeout changed in ${CURSOR_HOOKS_JSON_PATH}.`,
  'below-limit':
    `Raised the usabl stop hook's timeout in ${CURSOR_HOOKS_JSON_PATH} to ${CURSOR_STOP_TIMEOUT_SECONDS} seconds, ` +
    `and ${CURSOR_STOP_SCRIPT_PATH} passes the same limit to usabl, so usabl answers before Cursor ends the hook. ` +
    `Only the timeout changed in ${CURSOR_HOOKS_JSON_PATH}.`,
  'script-no-limit':
    `Rewrote ${CURSOR_STOP_SCRIPT_PATH} to pass the usabl stop hook's timeout in ${CURSOR_HOOKS_JSON_PATH} to usabl. ` +
    'The old script passed none, so a value in the environment Cursor runs in could put usabl\'s deadline past Cursor\'s limit.',
  'script-mismatch':
    `Rewrote ${CURSOR_STOP_SCRIPT_PATH} to pass the usabl stop hook's timeout in ${CURSOR_HOOKS_JSON_PATH} to usabl, ` +
    'so usabl plans its deadline to the limit Cursor enforces.',
};

function cursorRefusalMessage(path: string): string {
  return [
    `Refusing to overwrite ${path}: it exists but is not the canonical usabl Cursor wiring.`,
    'If it is an older usabl Cursor install, delete the file and re-run "usabl install --cursor".',
    'If you edited it on purpose, keep your version; usabl will not clobber it.',
  ].join('\n');
}

export async function writeCursor(fs: InstallFs, plan: CursorPlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    for (const file of plan.files) {
      await fs.writeFile(file.path, file.draft);
    }
    const paths = plan.files.map((file) => file.path).join(', ');
    const hasStopScript = plan.files.some((f) => f.path === CURSOR_STOP_SCRIPT_PATH);
    const chmodHint = hasStopScript
      ? `\nMake the stop script executable: chmod +x ${CURSOR_STOP_SCRIPT_PATH}`
      : '';
    const rewriteNote =
      plan.rewrites.length === 0
        ? ''
        : `\nRewrote ${plan.rewrites.join(', ')}: the old files ran "${LEGACY_USABL_RUN}", which downloads a package when usabl is not installed. ` +
          `They now run "${USABL_RUN}", which never downloads.`;
    const timeoutNote = plan.timeoutProblem === undefined ? '' : `\n${CURSOR_TIMEOUT_NOTES[plan.timeoutProblem]}`;
    return {
      exitCode: 0,
      action: 'written',
      path: plan.files[0]?.path ?? CURSOR_HOOKS_JSON_PATH,
      message: `Wrote ${paths}. Review these drafts before you merge them.${rewriteNote}${timeoutNote}${chmodHint}`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: CURSOR_HOOKS_JSON_PATH,
      message: `Cursor wiring is already present at ${plan.paths.join(', ')}. No change.`,
    };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: plan.reason,
  };
}
