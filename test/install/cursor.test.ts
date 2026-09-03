/**
 * The Cursor install generator writes four files: hooks.json and a stop-hook shell script
 * (the enforcement surface), plus a /usabl-check command and a UI rule (advisory surfaces).
 * hooks.json gets a JSON-aware merge that preserves unrelated hooks. The other three files
 * are whole-file drafts that refuse when a differing file is present. Refusal guards are
 * load-bearing: clobbering hooks.json or the stop script could break the operator's setup.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  buildCursorHooksJson,
  buildCursorRuleContents,
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_HOOKS_JSON_PATH,
  CURSOR_RULE_CONTENTS,
  CURSOR_RULE_PATH,
  CURSOR_STOP_SCRIPT,
  CURSOR_STOP_SCRIPT_PATH,
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

  it('stop script calls npx usabl stop-hook --cursor', () => {
    expect(CURSOR_STOP_SCRIPT).toContain('npx usabl stop-hook --cursor');
    expect(CURSOR_STOP_SCRIPT).toContain('#!/usr/bin/env bash');
  });
});

describe('buildCursorHooksJson', () => {
  it('produces a hooks.json with version 1 and a stop entry', () => {
    const json = buildCursorHooksJson(null);
    const parsed = JSON.parse(json) as { version: number; hooks: { stop: unknown[] } };
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.stop).toHaveLength(1);
  });

  it('sets a loop_limit to prevent infinite loops', () => {
    const json = buildCursorHooksJson(null);
    const parsed = JSON.parse(json) as { hooks: { stop: Array<{ loop_limit?: number }> } };
    expect(parsed.hooks.stop[0]?.loop_limit).toBeGreaterThan(0);
  });

  it('preserves existing hooks when merging', () => {
    const existing = { afterFileEdit: [{ command: '.cursor/hooks/format.sh' }] };
    const json = buildCursorHooksJson(existing);
    const parsed = JSON.parse(json) as {
      hooks: { afterFileEdit: unknown[]; stop: unknown[] };
    };
    expect(parsed.hooks.afterFileEdit).toHaveLength(1);
    expect(parsed.hooks.stop).toHaveLength(1);
  });
});

describe('planCursor', () => {
  it('plans all four files when nothing exists', async () => {
    const plan = await planCursor(memoryFs({}), DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan.action).toBe('write');
    if (plan.action === 'write') {
      expect(plan.files).toHaveLength(4);
      const paths = plan.files.map((f) => f.path);
      expect(paths).toContain(CURSOR_HOOKS_JSON_PATH);
      expect(paths).toContain(CURSOR_STOP_SCRIPT_PATH);
      expect(paths).toContain(CURSOR_COMMAND_PATH);
      expect(paths).toContain(CURSOR_RULE_PATH);
    }
  });

  it('reports already wired when all four files match canonical drafts', async () => {
    const fs = memoryFs({
      [CURSOR_HOOKS_JSON_PATH]: buildCursorHooksJson(null),
      [CURSOR_STOP_SCRIPT_PATH]: CURSOR_STOP_SCRIPT,
      [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
      [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
    });
    const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan.action).toBe('already-wired');
  });

  it('refuses when hooks.json has a non-usabl stop hook', async () => {
    const existing = JSON.stringify(
      { version: 1, hooks: { stop: [{ command: '.cursor/hooks/my-custom-stop.sh' }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CURSOR_HOOKS_JSON_PATH]: existing });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CURSOR_HOOKS_JSON_PATH]).toBe(existing);
  });

  it('refuses when hooks.json is unparseable', async () => {
    const broken = '{ this is not json';
    const fs = memoryFs({ [CURSOR_HOOKS_JSON_PATH]: broken });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CURSOR_HOOKS_JSON_PATH]).toBe(broken);
  });

  it('refuses when the stop script differs from the canonical version', async () => {
    const custom = '#!/usr/bin/env bash\necho "my custom hook"\n';
    const fs = memoryFs({ [CURSOR_STOP_SCRIPT_PATH]: custom });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(custom);
  });

  it('refuses when a different command file already occupies the path', async () => {
    const plan = await planCursor(
      memoryFs({ [CURSOR_COMMAND_PATH]: '# custom command\n' }),
      DEFAULT_CURSOR_UI_FILE_GLOBS,
    );
    expect(plan.action).toBe('refuse');
    if (plan.action === 'refuse') {
      expect(plan.path).toBe(CURSOR_COMMAND_PATH);
    }
  });

  it('preserves unrelated hooks and adds the usabl stop hook', async () => {
    const existing = JSON.stringify(
      { version: 1, hooks: { afterFileEdit: [{ command: '.cursor/hooks/format.sh' }] } },
      null,
      2,
    );
    const fs = memoryFs({ [CURSOR_HOOKS_JSON_PATH]: existing });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(0);
    const merged = JSON.parse(fs.store[CURSOR_HOOKS_JSON_PATH] ?? '') as {
      hooks: { afterFileEdit: unknown[]; stop: unknown[] };
    };
    expect(merged.hooks.afterFileEdit).toHaveLength(1);
    expect(merged.hooks.stop).toHaveLength(1);
  });

  it('writes only missing files when some canonical files are already present', async () => {
    const fs = memoryFs({
      [CURSOR_HOOKS_JSON_PATH]: buildCursorHooksJson(null),
      [CURSOR_STOP_SCRIPT_PATH]: CURSOR_STOP_SCRIPT,
      [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
    });
    const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan.action).toBe('write');
    if (plan.action === 'write') {
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0]?.path).toBe(CURSOR_RULE_PATH);
    }
  });
});

describe('writeCursor', () => {
  it('writes all drafts when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({});
    const first = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(first.exitCode).toBe(0);
    expect(first.action).toBe('written');
    expect(fs.store[CURSOR_HOOKS_JSON_PATH]).toBeDefined();
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(CURSOR_STOP_SCRIPT);
    expect(fs.store[CURSOR_COMMAND_PATH]).toBe(CURSOR_COMMAND_CONTENTS);
    expect(fs.store[CURSOR_RULE_PATH]).toBe(CURSOR_RULE_CONTENTS);

    const second = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
  });

  it('reports chmod hint when the stop script is written', async () => {
    const fs = memoryFs({});
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.message).toContain('chmod +x');
    expect(result.message).toContain(CURSOR_STOP_SCRIPT_PATH);
  });
});
