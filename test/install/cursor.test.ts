import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_RULE_CONTENTS,
  CURSOR_RULE_PATH,
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

describe('CURSOR assistant contents', () => {
  it('declares the /usabl-check command and pins the advisory self-check command', () => {
    expect(CURSOR_COMMAND_PATH).toBe('.cursor/commands/usabl-check.md');
    expect(CURSOR_COMMAND_CONTENTS).toContain('npx usabl check --self-check');
    expect(CURSOR_RULE_CONTENTS).toContain('globs: src/**/*.{tsx,jsx,css}');
    expect(CURSOR_RULE_CONTENTS).toContain('/usabl-check');
  });

  it('states the command is advisory and that the gate decides proof', () => {
    expect(CURSOR_COMMAND_CONTENTS.toLowerCase()).toContain('advisory');
    expect(CURSOR_COMMAND_CONTENTS).toContain('gate');
  });
});

describe('planCursor', () => {
  it('plans full drafts when both Cursor files are absent', async () => {
    const plan = await planCursor(memoryFs({}));
    expect(plan.action).toBe('write');
    if (plan.action === 'write') {
      expect(plan.files).toHaveLength(2);
      expect(plan.files.map((file) => file.path)).toEqual([CURSOR_COMMAND_PATH, CURSOR_RULE_PATH]);
    }
  });

  it('reports already wired when both files match the canonical drafts', async () => {
    const plan = await planCursor(
      memoryFs({
        [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
        [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
      }),
    );
    expect(plan.action).toBe('already-wired');
  });

  it('refuses when a different file already occupies one of the paths', async () => {
    const plan = await planCursor(
      memoryFs({
        [CURSOR_COMMAND_PATH]: '# custom command\n',
        [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
      }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.path).toBe(CURSOR_COMMAND_PATH);
  });
});

describe('writeCursor', () => {
  it('writes both drafts when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({});
    const first = await writeCursor(fs, await planCursor(fs));
    expect(first.exitCode).toBe(0);
    expect(first.action).toBe('written');
    expect(fs.store[CURSOR_COMMAND_PATH]).toBe(CURSOR_COMMAND_CONTENTS);
    expect(fs.store[CURSOR_RULE_PATH]).toBe(CURSOR_RULE_CONTENTS);

    const second = await writeCursor(fs, await planCursor(fs));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
  });
});
