/**
 * Claude settings install generator for `usabl install --claude`.
 * It wires a Stop hook that runs the stable `usabl stop-hook` command. settings.json is
 * JSON, so this parses and merges: it adds the usabl Stop hook, preserves unrelated
 * hooks, and updates a usabl-owned hook still wired to the retired raw dist path. It
 * refuses when the file is unparseable or when a Stop hook it cannot recognize is
 * present, rather than risk a double-run or clobbering an operator's own hook.
 */
import type { InstallFs, InstallResult } from './index.js';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

// npx resolves the locally installed usabl bin (package.json bin: usabl -> dist/cli.js)
// without assuming a global install, so this command works from any project that has
// usabl as a dependency.
export const STOP_HOOK_COMMAND = 'npx usabl stop-hook';

export type ClaudePlan =
  | { action: 'write'; path: string; contents: string }
  | { action: 'update'; path: string; contents: string }
  | { action: 'already-wired'; path: string }
  | { action: 'refuse'; path: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUsablStopCommand(command: string): boolean {
  // The stable command and the retired raw dist path are both usabl-owned. Recognizing
  // the old form lets us cleanly migrate it to the stable command.
  return command.includes('usabl stop-hook') || command.includes('usabl/dist/stop-hook-runner');
}

function canonicalStopEntry(): { hooks: Array<{ type: string; command: string }> } {
  return { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }] };
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
    '  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "npx usabl stop-hook" } ] } ] }',
  ].join('\n');
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

// Rewrite every usabl-owned Stop command in place to the stable command, leaving all
// other keys, matchers, and hook entries exactly as they were.
function rewriteUsablCommands(stop: unknown[]): void {
  for (const entry of stop) {
    if (!isRecord(entry) || !Array.isArray(entry['hooks'])) {
      continue;
    }
    for (const hook of entry['hooks']) {
      if (isRecord(hook) && hook['type'] === 'command' && typeof hook['command'] === 'string' && isUsablStopCommand(hook['command'])) {
        hook['command'] = STOP_HOOK_COMMAND;
      }
    }
  }
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

  // Build the merged object without touching the original, so a refusal path never leaves
  // a half-written file. Only non-Stop content and usabl-owned commands are affected.
  const updated = structuredClone(parsed) as Record<string, unknown>;
  const updatedHooks = isRecord(updated['hooks']) ? (updated['hooks'] as Record<string, unknown>) : {};
  updated['hooks'] = updatedHooks;
  const updatedStop = Array.isArray(updatedHooks['Stop']) ? (updatedHooks['Stop'] as unknown[]) : [];
  updatedHooks['Stop'] = updatedStop;
  if (counts.usabl > 0) {
    rewriteUsablCommands(updatedStop);
  } else {
    updatedStop.push(canonicalStopEntry());
  }

  // Idempotence check: if the merge changes nothing, the hook is already wired.
  if (JSON.stringify(updated) === JSON.stringify(parsed)) {
    return { action: 'already-wired', path: CLAUDE_SETTINGS_PATH };
  }
  return { action: 'update', path: CLAUDE_SETTINGS_PATH, contents: `${JSON.stringify(updated, null, 2)}\n` };
}

export async function writeClaude(fs: InstallFs, plan: ClaudePlan): Promise<InstallResult> {
  if (plan.action === 'write' || plan.action === 'update') {
    await fs.writeFile(plan.path, plan.contents);
    const verb = plan.action === 'write' ? 'Wrote' : 'Updated';
    return {
      exitCode: 0,
      action: 'written',
      path: plan.path,
      message: `${verb} ${plan.path} to run the usabl Stop hook (${STOP_HOOK_COMMAND}). Review this draft before you merge it.`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: plan.path,
      message: `${plan.path} already runs the usabl Stop hook (${STOP_HOOK_COMMAND}). No change.`,
    };
  }
  return { exitCode: 2, action: 'refused', path: plan.path, message: plan.reason };
}
