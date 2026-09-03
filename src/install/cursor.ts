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
import type { InstallFs, InstallResult } from './index.js';

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
// `npx usabl stop-hook --cursor`, which emits the Cursor-native followup_message protocol.
// All gate logic stays inside the engine's stop-hook runner; this script is a thin adapter.
export const CURSOR_STOP_SCRIPT = `#!/usr/bin/env bash
# Cursor stop hook adapter for usabl.
# Pipes Cursor's stdin through the engine and emits followup_message to loop on block.
# This script is managed by "usabl install --cursor". Manual edits will be detected.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

cat | npx usabl stop-hook --cursor
`;

// The hooks.json content. Written as a string so byte-identical comparison works for
// idempotence, the same way the other install drafts work.
export function buildCursorHooksJson(existingHooks: Record<string, unknown> | null): string {
  const stopEntry = {
    command: '.cursor/hooks/usabl-stop.sh',
    timeout: 300,
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

When changing user interface code:

- After a meaningful UI change, run \`/usabl-check\` or \`npx usabl check --self-check\` from the repository root.
- Treat usabl findings as the source of truth for machine-checkable barriers.
- Explain verdicts honestly: \`verified\`, \`regression\`, \`not_covered\`, or \`approval_required\`.
- Do not call work verified from the self-check alone. The gate (\`usabl check\` / CI) decides proof.
- Prefer fixing source over query-parameter previews or disabling checks.
`;
}

export const CURSOR_RULE_CONTENTS = buildCursorRuleContents(DEFAULT_CURSOR_UI_FILE_GLOBS);

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
    { path: CURSOR_COMMAND_PATH, draft: CURSOR_COMMAND_CONTENTS },
    { path: CURSOR_RULE_PATH, draft: buildCursorRuleContents(uiFileGlobs) },
  ] as const;
}

export type CursorPlan =
  | { action: 'write'; files: Array<{ path: string; draft: string }> }
  | { action: 'already-wired'; paths: string[] }
  | { action: 'refuse'; path: string; reason: string };

// Plan the hooks.json merge separately because it needs JSON-aware merging (preserving
// unrelated hooks), unlike the simple whole-file drafts for command and rule.
async function planHooksJson(
  fs: InstallFs,
): Promise<
  | { ok: true; action: 'write'; draft: string }
  | { ok: true; action: 'already-wired' }
  | { ok: false; reason: string }
> {
  const existing = await fs.readFile(CURSOR_HOOKS_JSON_PATH);
  if (existing === null) {
    return { ok: true, action: 'write', draft: buildCursorHooksJson(null) };
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
      return { ok: true, action: 'already-wired' };
    }
  }

  // Merge the stop hook into existing hooks, preserving everything else.
  const existingHooks = isRecord(hooks) ? (hooks as Record<string, unknown>) : {};
  return { ok: true, action: 'write', draft: buildCursorHooksJson(existingHooks) };
}

export async function planCursor(fs: InstallFs, uiFileGlobs: string[]): Promise<CursorPlan> {
  // Plan hooks.json (JSON-aware merge) and the stop script (whole-file).
  const hooksPlan = await planHooksJson(fs);
  if (!hooksPlan.ok) {
    return { action: 'refuse', path: CURSOR_HOOKS_JSON_PATH, reason: hooksPlan.reason };
  }

  const existingScript = await fs.readFile(CURSOR_STOP_SCRIPT_PATH);
  if (existingScript !== null && existingScript !== CURSOR_STOP_SCRIPT) {
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
  const existing: Array<{ path: string; draft: string; contents: string | null }> = [];
  for (const file of files) {
    existing.push({ ...file, contents: await fs.readFile(file.path) });
  }

  for (const file of existing) {
    if (file.contents !== null && file.contents !== file.draft) {
      return {
        action: 'refuse',
        path: file.path,
        reason: cursorRefusalMessage(file.path),
      };
    }
  }

  // Collect all files that need writing.
  const toWrite: Array<{ path: string; draft: string }> = [];
  if (hooksPlan.action === 'write') {
    toWrite.push({ path: CURSOR_HOOKS_JSON_PATH, draft: hooksPlan.draft });
  }
  if (existingScript === null) {
    toWrite.push({ path: CURSOR_STOP_SCRIPT_PATH, draft: CURSOR_STOP_SCRIPT });
  }
  for (const file of existing) {
    if (file.contents === null) {
      toWrite.push({ path: file.path, draft: file.draft });
    }
  }

  if (toWrite.length === 0) {
    const allPaths = [CURSOR_HOOKS_JSON_PATH, CURSOR_STOP_SCRIPT_PATH, ...files.map((f) => f.path)];
    return { action: 'already-wired', paths: allPaths };
  }

  return { action: 'write', files: toWrite };
}

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
    return {
      exitCode: 0,
      action: 'written',
      path: plan.files[0]?.path ?? CURSOR_HOOKS_JSON_PATH,
      message: `Wrote ${paths}. Review these drafts before you merge them.${chmodHint}`,
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
