import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  buildCursorRuleContents,
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_RULE_CONTENTS,
  CURSOR_RULE_PATH,
  cursorRuleGlobs,
  DEFAULT_CURSOR_UI_FILE_GLOBS,
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

  it('derives rule globs from uiFileGlobs instead of hardcoding src/', () => {
    expect(cursorRuleGlobs(['fixtures/app/src/**'])).toBe('fixtures/app/src/**/*.{tsx,jsx,css}');
    expect(buildCursorRuleContents(['fixtures/app/src/**'])).toContain(
      'globs: fixtures/app/src/**/*.{tsx,jsx,css}',
    );
  });

  it('passes single files through and only appends extensions to directory globs', () => {
    // A declared UI file is not a directory. Appending /**/*.{tsx,jsx,css} to it matches
    // nothing, which is the silent non-coverage this derivation exists to prevent.
    expect(cursorRuleGlobs(['src/demo/scenarios.ts'])).toBe('src/demo/scenarios.ts');
    expect(cursorRuleGlobs(['src/lib/variant.ts'])).toBe('src/lib/variant.ts');
    expect(cursorRuleGlobs(['src/components/DemoControls.tsx'])).toBe(
      'src/components/DemoControls.tsx',
    );
    expect(cursorRuleGlobs(['src/pages/*.tsx'])).toBe('src/pages/*.tsx');
    expect(cursorRuleGlobs(['src/index.css'])).toBe('src/index.css');
    expect(cursorRuleGlobs(['src/**'])).toBe('src/**/*.{tsx,jsx,css}');
    expect(cursorRuleGlobs(['src/components/*'])).toBe('src/components/**/*.{tsx,jsx,css}');
    expect(cursorRuleGlobs(['src'])).toBe('src/**/*.{tsx,jsx,css}');
    expect(cursorRuleGlobs(['src/**', 'src/demo/scenarios.ts'])).toBe(
      'src/**/*.{tsx,jsx,css},src/demo/scenarios.ts',
    );
  });

  it('states the command is advisory and that the gate decides proof', () => {
    expect(CURSOR_COMMAND_CONTENTS.toLowerCase()).toContain('advisory');
    expect(CURSOR_COMMAND_CONTENTS).toContain('gate');
  });
});

describe('planCursor', () => {
  it('plans full drafts when both Cursor files are absent', async () => {
    const plan = await planCursor(memoryFs({}), DEFAULT_CURSOR_UI_FILE_GLOBS);
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
      DEFAULT_CURSOR_UI_FILE_GLOBS,
    );
    expect(plan.action).toBe('already-wired');
  });

  it('refuses when a different file already occupies one of the paths', async () => {
    const plan = await planCursor(
      memoryFs({
        [CURSOR_COMMAND_PATH]: '# custom command\n',
        [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
      }),
      DEFAULT_CURSOR_UI_FILE_GLOBS,
    );
    expect(plan.action).toBe('refuse');
    if (plan.action !== 'refuse') {
      throw new Error('expected refuse plan');
    }
    expect(plan.path).toBe(CURSOR_COMMAND_PATH);
  });

  it('plans a write for only the missing file when one canonical file is already present', async () => {
    const plan = await planCursor(
      memoryFs({
        [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
      }),
      DEFAULT_CURSOR_UI_FILE_GLOBS,
    );
    expect(plan.action).toBe('write');
    if (plan.action === 'write') {
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0]?.path).toBe(CURSOR_RULE_PATH);
      expect(plan.files[0]?.draft).toBe(CURSOR_RULE_CONTENTS);
    }
  });
});

describe('writeCursor', () => {
  it('writes both drafts when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({});
    const first = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(first.exitCode).toBe(0);
    expect(first.action).toBe('written');
    expect(fs.store[CURSOR_COMMAND_PATH]).toBe(CURSOR_COMMAND_CONTENTS);
    expect(fs.store[CURSOR_RULE_PATH]).toBe(CURSOR_RULE_CONTENTS);

    const second = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
  });

  it('writes only the missing file when the other canonical file is already present', async () => {
    const fs = memoryFs({
      [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
    });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(fs.store[CURSOR_COMMAND_PATH]).toBe(CURSOR_COMMAND_CONTENTS);
    expect(fs.store[CURSOR_RULE_PATH]).toBe(CURSOR_RULE_CONTENTS);
    expect(result.message).toContain(CURSOR_RULE_PATH);
  });
});
