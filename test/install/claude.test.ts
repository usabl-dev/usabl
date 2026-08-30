/**
 * The Claude settings generator merges JSON safely. It adds the usabl Stop hook,
 * preserves unrelated hooks, updates a usabl-owned hook wired to the retired dist
 * path, and refuses when a Stop hook it cannot recognize is present or the file is
 * corrupt. The refusal guards are asserted to be load-bearing: removing them would
 * let usabl double-run alongside, or clobber, an operator's own Stop hook.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  CLAUDE_SETTINGS_PATH,
  STOP_HOOK_COMMAND,
  isUsablStopCommand,
  planClaude,
  writeClaude,
} from '../../src/install/claude.js';

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

function stopCommands(raw: string): string[] {
  const parsed = JSON.parse(raw) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> };
  };
  const commands: string[] = [];
  for (const entry of parsed.hooks?.Stop ?? []) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type === 'command' && typeof hook.command === 'string') {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

describe('planClaude', () => {
  it('wires npx usabl stop-hook so the installed bin resolves without a global install', async () => {
    expect(STOP_HOOK_COMMAND).toBe('npx usabl stop-hook');
    const fs = memoryFs({});
    const result = await writeClaude(fs, await planClaude(fs));
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(stopCommands(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual(['npx usabl stop-hook']);
  });

  it('is idempotent once the stable command is wired', async () => {
    const fs = memoryFs({});
    await writeClaude(fs, await planClaude(fs));
    const again = await planClaude(fs);
    expect(again.action).toBe('already-wired');
    const result = await writeClaude(fs, again);
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('already-wired');
  });

  it('preserves unrelated hooks and adds the usabl Stop hook', async () => {
    const existing = JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const result = await writeClaude(fs, await planClaude(fs));

    expect(result.exitCode).toBe(0);
    const merged = JSON.parse(fs.store[CLAUDE_SETTINGS_PATH] ?? '') as {
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(stopCommands(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual(['npx usabl stop-hook']);
  });

  it('updates a usabl-owned hook wired to the retired dist path, preserving siblings', async () => {
    const existing = JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'node node_modules/usabl/dist/stop-hook-runner.js' }] }],
        },
      },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const plan = await planClaude(fs);
    expect(plan.action).toBe('update');
    const result = await writeClaude(fs, plan);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(stopCommands(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual(['npx usabl stop-hook']);
    const merged = JSON.parse(fs.store[CLAUDE_SETTINGS_PATH] ?? '') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(merged.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('echo keep-me');
  });

  it('refuses when a Stop hook it cannot recognize is present', async () => {
    const existing = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'run-my-own-formatter' }] }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const result = await writeClaude(fs, await planClaude(fs));

    // Load-bearing: exit 2 and the operator's file untouched. Removing this guard
    // would either add a second Stop hook (double-run) or overwrite theirs.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(existing);
    expect(result.message.toLowerCase()).toContain('stop hook');
  });

  it('refuses to merge into unparseable JSON rather than clobber it', async () => {
    const broken = '{ this is not json';
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: broken });
    const result = await writeClaude(fs, await planClaude(fs));

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(broken);
  });
});

describe('isUsablStopCommand', () => {
  it('recognizes the stable command and the retired dist path only', () => {
    expect(isUsablStopCommand('npx usabl stop-hook')).toBe(true);
    expect(isUsablStopCommand('node node_modules/usabl/dist/stop-hook-runner.js')).toBe(true);
    expect(isUsablStopCommand('run-my-own-formatter')).toBe(false);
  });
});
