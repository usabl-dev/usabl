/**
 * The generated Stop hooks state their time limit. A hook the assistant ends at its limit lets the
 * stop go on, so the limit must be one usabl knows and plans its own deadline to. The Claude Code
 * hook sets a `timeout`, and its command sets USABL_STOP_HOOK_TIMEOUT to the same number, which
 * the runner reads. The Cursor hook keeps its 300 second limit, which the runner assumes.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  CLAUDE_SETTINGS_PATH,
  PREVIOUS_STOP_HOOK_COMMAND,
  STOP_HOOK_COMMAND,
  isUsablStopCommand,
  planClaude,
  stopHookCommand,
  writeClaude,
} from '../../src/install/claude.js';
import {
  buildCursorHooksJson,
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_HOOKS_JSON_PATH,
  CURSOR_RULE_CONTENTS,
  CURSOR_RULE_PATH,
  CURSOR_STOP_SCRIPT,
  CURSOR_STOP_SCRIPT_PATH,
  cursorStopScript,
  DEFAULT_CURSOR_UI_FILE_GLOBS,
  PREVIOUS_CURSOR_STOP_SCRIPT,
  planCursor,
  writeCursor,
} from '../../src/install/cursor.js';

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

interface StopHook {
  type?: string;
  command?: string;
  timeout?: unknown;
}

function settingsWith(hook: StopHook): string {
  return `${JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }, null, 2)}\n`;
}

function stopHooks(raw: string): StopHook[] {
  const parsed = JSON.parse(raw) as { hooks?: { Stop?: Array<{ hooks?: StopHook[] }> } };
  return (parsed.hooks?.Stop ?? []).flatMap((entry) => entry.hooks ?? []);
}

describe('the Claude Code Stop hook states its time limit', () => {
  it('writes a timeout of 600 seconds and sets the same limit for the runner in the command', async () => {
    expect(STOP_HOOK_COMMAND.startsWith('USABL_STOP_HOOK_TIMEOUT=600 npm_config_loglevel=silent npm exec --no -- usabl stop-hook || ')).toBe(true);
    const fs = memoryFs({});
    const result = await writeClaude(fs, await planClaude(fs));
    expect(result.exitCode).toBe(0);
    expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 600 }]);
    expect(result.message).toContain('600 seconds');
  });

  it('adds the timeout to a hook the previous release wrote, which set none', async () => {
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: PREVIOUS_STOP_HOOK_COMMAND }) });
    const plan = await planClaude(fs);
    expect(plan).toMatchObject({ action: 'update', reason: 'timeout', timeoutProblem: 'missing' });
    await writeClaude(fs, plan);
    expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 600 }]);
  });

  it('keeps a limit a person raised when the command and the timeout agree', async () => {
    const raised = settingsWith({ type: 'command', command: stopHookCommand(1200), timeout: 1200 });
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: raised });
    expect(isUsablStopCommand(stopHookCommand(1200))).toBe(true);
    expect((await planClaude(fs)).action).toBe('already-wired');
  });

  it('sets the command to a timeout a person raised', async () => {
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: STOP_HOOK_COMMAND, timeout: 900 }) });
    const plan = await planClaude(fs);
    expect(plan).toMatchObject({ action: 'update', reason: 'timeout', timeoutProblem: 'mismatch' });
    await writeClaude(fs, plan);
    expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: stopHookCommand(900), timeout: 900 }]);
  });

  it('keeps the timeout a person set, lower or higher, and makes the command match it', async () => {
    // The timeout is the limit Claude Code enforces, so it wins over the number in the command.
    for (const [commandLimit, timeout] of [
      [600, 120],
      [1200, 600],
    ] as const) {
      const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: stopHookCommand(commandLimit), timeout }) });
      const plan = await planClaude(fs);
      expect(plan).toMatchObject({ action: 'update', reason: 'timeout', timeoutProblem: 'mismatch' });
      await writeClaude(fs, plan);
      expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: stopHookCommand(timeout), timeout }]);
    }
  });

  it('takes the limit from the command when the timeout is unusable', async () => {
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: stopHookCommand(900), timeout: '900' }) });
    await writeClaude(fs, await planClaude(fs));
    expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: stopHookCommand(900), timeout: 900 }]);
  });

  it('replaces a limit below the minimum with the default', async () => {
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: stopHookCommand(20), timeout: 20 }) });
    const plan = await planClaude(fs);
    expect(plan).toMatchObject({ action: 'update', reason: 'timeout', timeoutProblem: 'below-minimum' });
    await writeClaude(fs, plan);
    expect(stopHooks(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual([{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 600 }]);
  });

  it('reports a timeout that is not a number as missing', async () => {
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith({ type: 'command', command: STOP_HOOK_COMMAND, timeout: '600' }) });
    expect(await planClaude(fs)).toMatchObject({ action: 'update', reason: 'timeout', timeoutProblem: 'missing' });
  });

  it('still refuses a command with a limit that is not whole seconds, or any other change', () => {
    expect(isUsablStopCommand(stopHookCommand(600).replace('=600', '=6e2'))).toBe(false);
    expect(isUsablStopCommand(stopHookCommand(600).replace('=600', '=$(id)'))).toBe(false);
    expect(isUsablStopCommand(`FOO=1 ${STOP_HOOK_COMMAND}`)).toBe(false);
    expect(isUsablStopCommand(`${STOP_HOOK_COMMAND} --debug`)).toBe(false);
  });
});

describe('the Cursor stop hook keeps its 300 second limit', () => {
  const others = {
    [CURSOR_STOP_SCRIPT_PATH]: CURSOR_STOP_SCRIPT,
    [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
    [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
  };

  function hooksJsonWith(timeout: number | undefined): string {
    const entry: Record<string, unknown> = { command: '.cursor/hooks/usabl-stop.sh', loop_limit: 3 };
    if (timeout !== undefined) {
      entry['timeout'] = timeout;
    }
    return `${JSON.stringify({ version: 1, hooks: { stop: [entry] } }, null, 2)}\n`;
  }

  it('writes 300 seconds', () => {
    const parsed = JSON.parse(buildCursorHooksJson(null)) as { hooks: { stop: Array<{ timeout?: number }> } };
    expect(parsed.hooks.stop[0]?.timeout).toBe(300);
  });

  it('sets the limit again when the usabl stop entry has none or a lower one', async () => {
    for (const timeout of [undefined, 100]) {
      const fs = memoryFs({ ...others, [CURSOR_HOOKS_JSON_PATH]: hooksJsonWith(timeout) });
      const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
      expect(plan).toMatchObject({ action: 'write', timeoutProblem: timeout === undefined ? 'missing' : 'below-limit' });
      const result = await writeCursor(fs, plan);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.store[CURSOR_HOOKS_JSON_PATH] ?? '')).toEqual(JSON.parse(hooksJsonWith(300)));
      expect(result.message).toContain('300 seconds');
    }
  });

  it('changes only the timeout of the usabl stop entry, and keeps every other key the person wrote', async () => {
    const before = {
      version: 1,
      note: 'team setting',
      hooks: {
        afterFileEdit: [{ command: './format.sh' }],
        stop: [{ command: '.cursor/hooks/usabl-stop.sh', timeout: 120, loop_limit: 10, owner: 'web team' }],
      },
    };
    const fs = memoryFs({ ...others, [CURSOR_HOOKS_JSON_PATH]: `${JSON.stringify(before, null, 2)}\n` });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(0);

    const after = JSON.parse(fs.store[CURSOR_HOOKS_JSON_PATH] ?? '') as typeof before;
    expect(after).toEqual({
      ...before,
      hooks: { ...before.hooks, stop: [{ ...before.hooks.stop[0], timeout: 300 }] },
    });
    expect(result.message).toContain('Only the timeout changed');
  });
});

describe('the Cursor stop script passes its own limit to usabl', () => {
  const simple = {
    [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
    [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
  };

  function hooksJsonWith(timeout: number): string {
    const entry = { command: '.cursor/hooks/usabl-stop.sh', timeout, loop_limit: 3 };
    return `${JSON.stringify({ version: 1, hooks: { stop: [entry] } }, null, 2)}\n`;
  }

  it('sets USABL_STOP_HOOK_TIMEOUT to the 300 second limit, so a value inherited from the environment cannot win', () => {
    expect(CURSOR_STOP_SCRIPT).toContain('USABL_STOP_HOOK_TIMEOUT=300 npm_config_loglevel=silent npm exec --no -- usabl stop-hook --cursor');
    expect(cursorStopScript(900)).toContain('USABL_STOP_HOOK_TIMEOUT=900 npm_config_loglevel=silent');
  });

  it('matches the script to a timeout a person raised in hooks.json', async () => {
    const fs = memoryFs({ ...simple, [CURSOR_STOP_SCRIPT_PATH]: CURSOR_STOP_SCRIPT, [CURSOR_HOOKS_JSON_PATH]: hooksJsonWith(900) });
    const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan).toMatchObject({ action: 'write', timeoutProblem: 'script-mismatch' });
    await writeCursor(fs, plan);
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(cursorStopScript(900));
    expect(fs.store[CURSOR_HOOKS_JSON_PATH]).toBe(hooksJsonWith(900));
    expect((await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS)).action).toBe('already-wired');
  });

  it('rewrites the script the previous release wrote, which passed no limit', async () => {
    const fs = memoryFs({ ...simple, [CURSOR_STOP_SCRIPT_PATH]: PREVIOUS_CURSOR_STOP_SCRIPT, [CURSOR_HOOKS_JSON_PATH]: hooksJsonWith(300) });
    const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan).toMatchObject({ action: 'write', timeoutProblem: 'script-no-limit' });
    const result = await writeCursor(fs, plan);
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(CURSOR_STOP_SCRIPT);
    expect(result.message).toContain(CURSOR_STOP_SCRIPT_PATH);
  });

  it('still refuses a script a person edited in any other way', async () => {
    const edited = CURSOR_STOP_SCRIPT.replace('set -euo pipefail', 'set -eu');
    const fs = memoryFs({ ...simple, [CURSOR_STOP_SCRIPT_PATH]: edited, [CURSOR_HOOKS_JSON_PATH]: hooksJsonWith(300) });
    expect((await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS)).action).toBe('refuse');
  });
});
