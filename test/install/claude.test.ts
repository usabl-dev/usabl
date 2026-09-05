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

  it('migrates a bare usabl stop-hook command to the stable command', async () => {
    const existing = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'usabl stop-hook' }] }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const plan = await planClaude(fs);
    expect(plan.action).toBe('update');
    const result = await writeClaude(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(stopCommands(fs.store[CLAUDE_SETTINGS_PATH] ?? '')).toEqual(['npx usabl stop-hook']);
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

  it('refuses a wrapped usabl command rather than destroy the operator command', async () => {
    // An env prefix and a redirect wrap the real hook. Substring matching would call this
    // usabl-owned and rewrite it to the bare command, silently dropping the operator's
    // customization. Anchored recognition must treat it as foreign and refuse.
    const command = 'FOO=bar npx usabl stop-hook 2>>/var/log/x.log';
    const existing = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const result = await writeClaude(fs, await planClaude(fs));

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(existing);
  });

  it('refuses a foreign command that only mentions the marker as data', async () => {
    const command = "grep -q 'usabl stop-hook' settings.json && ./notify.sh";
    const existing = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const result = await writeClaude(fs, await planClaude(fs));

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(existing);
  });

  it('refuses when more than one usabl Stop hook is present rather than hide a double-run', async () => {
    const existing = JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'npx usabl stop-hook' }] },
            { hooks: [{ type: 'command', command: 'node node_modules/usabl/dist/stop-hook-runner.js' }] },
          ],
        },
      },
      null,
      2,
    );
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    const result = await writeClaude(fs, await planClaude(fs));

    // Load-bearing: two usabl Stop hooks would both run. Reporting already-wired or
    // auto-collapsing would hide that, so it must refuse and leave the file untouched.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(existing);
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
  it('recognizes only the exact stable, bare, and plain retired-dist forms', () => {
    // Exact forms usabl emits or shipped are usabl-owned.
    expect(isUsablStopCommand('npx usabl stop-hook')).toBe(true);
    expect(isUsablStopCommand('usabl stop-hook')).toBe(true);
    expect(isUsablStopCommand('node node_modules/usabl/dist/stop-hook-runner.js')).toBe(true);
    // Surrounding whitespace is trimmed before matching.
    expect(isUsablStopCommand('  npx usabl stop-hook  ')).toBe(true);

    // Anything wrapped, prefixed, argument-extended, or foreign is not usabl-owned.
    expect(isUsablStopCommand('FOO=bar npx usabl stop-hook 2>>/var/log/x.log')).toBe(false);
    expect(isUsablStopCommand("grep -q 'usabl stop-hook' settings.json && ./notify.sh")).toBe(false);
    expect(isUsablStopCommand('npx usabl stop-hook --debug')).toBe(false);
    expect(isUsablStopCommand('node ./wrap.js && node node_modules/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('run-my-own-formatter')).toBe(false);
  });

  it('does not treat a directory that merely ends in "usabl" as usabl-owned', () => {
    // The retired-dist match forces a path-segment boundary before "usabl", so a foreign
    // directory whose name ends in "usabl" (an operator's own "notusabl" or "myusabl") is not
    // rewritten as if it were the retired usabl runner. "usabl" must be the whole final
    // directory before /dist, not a suffix of one.
    expect(isUsablStopCommand('node /path/notusabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node myusabl/dist/stop-hook-runner.js')).toBe(false);
    // The legitimate forms still match: "usabl" at a segment boundary or as the first token.
    expect(isUsablStopCommand('node /opt/node_modules/usabl/dist/stop-hook-runner.js')).toBe(true);
    expect(isUsablStopCommand('node usabl/dist/stop-hook-runner.js')).toBe(true);
  });

  it('rejects a path prefix carrying shell expansion, comment, or separator syntax', () => {
    // A match authorizes a silent rewrite, so the path prefix is an allowlist of literal POSIX
    // path characters. Anything that could be shell syntax fails closed: a match here would let
    // a foreign command with an expansion, a command substitution, or a comment be rewritten.
    expect(isUsablStopCommand('node $PATH/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node `cmd`/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node #/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node ~/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node a*/usabl/dist/stop-hook-runner.js')).toBe(false);
    expect(isUsablStopCommand('node a\\b/usabl/dist/stop-hook-runner.js')).toBe(false);
    // A command-separating newline must not join "node" to a following retired-path token.
    expect(isUsablStopCommand('node\nusabl/dist/stop-hook-runner.js')).toBe(false);
    // A leading-dash first token is a node option, not a script path, so it is not the retired
    // runner and must not be rewritten as if it were.
    expect(isUsablStopCommand('node -x/usabl/dist/stop-hook-runner.js')).toBe(false);
  });

  it('accepts real install-path characters that are not shell-expandable', () => {
    // pnpm encodes its virtual store with "+", and ordinary directories carry it too, so a
    // legitimate usabl hook under such a path must migrate, not be refused as foreign. "+" is
    // not shell-expandable, so allowing it does not reopen the injection surface.
    expect(
      isUsablStopCommand('node /work/c++-ui/node_modules/usabl/dist/stop-hook-runner.js'),
    ).toBe(true);
    expect(
      isUsablStopCommand('node node_modules/.pnpm/usabl@0.2.1/node_modules/usabl/dist/stop-hook-runner.js'),
    ).toBe(true);
  });
});
