/**
 * Generated hooks, skills, and Cursor files run usabl with `npm exec --no -- usabl`, never with
 * `npx usabl`.
 *
 * `npx usabl` downloads and runs whatever package holds the npm name usabl when usabl is not
 * installed, with no prompt when stdin is piped, as it is for a hook. `npm exec --no` runs a local
 * or global install and otherwise fails with no download. A hook that cannot run usabl fails with
 * one plain line that says so and how to install it, on an exit code that each host treats as a
 * failed hook and not as a block: Claude Code and Cursor both let the stop go on after exit 1, and
 * show the failure as a hook error. The installers take the old `npx usabl` files as their own and
 * rewrite them, and doctor reports an old file as a security drift.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallFs } from '../../src/install/index.js';
import {
  CLAUDE_SETTINGS_PATH,
  LEGACY_STOP_HOOK_COMMAND,
  planClaude,
  STOP_HOOK_COMMAND,
  writeClaude,
} from '../../src/install/claude.js';
import {
  CLAUDE_FIX_SKILL,
  CLAUDE_FIX_SKILL_CONTENTS,
  CLAUDE_FIX_SKILL_PATH,
  CLAUDE_SKILL_CONTENTS,
  CLAUDE_SKILL_PATH,
  installClaudeSkills,
  planClaudeSkill,
} from '../../src/install/claude-skill.js';
import {
  buildCursorHooksJson,
  buildCursorRuleContents,
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_HOOKS_JSON_PATH,
  CURSOR_RULE_PATH,
  CURSOR_STOP_SCRIPT,
  CURSOR_STOP_SCRIPT_PATH,
  DEFAULT_CURSOR_UI_FILE_GLOBS,
  planCursor,
  writeCursor,
} from '../../src/install/cursor.js';
import { USABL_NOT_INSTALLED_LINE, USABL_RUN } from '../../src/install/usabl-command.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { collectDoctorReport } from '../../src/doctor/index.js';

// The files the previous release wrote, byte for byte. A file that holds exactly these bytes is
// usabl's own, so a reinstall rewrites it.
const OLD_CHECK_SKILL = `---
name: usabl-check
description: Run the advisory usabl accessibility check during implementation and explain the current result.
allowed-tools: Bash(npx usabl check --self-check), Bash(npx usabl brief --json --files:*)
---

Before you start a task, run \`npx usabl brief --json --files <paths>\` from the repository
root, with the paths of the files the task will edit. Keep the screens it says the task
reaches and its \`done\` list in view while you work. The brief is a plan. Only the gate
decides a verdict.

Run \`npx usabl check --self-check\` from the repository root.

Report:

1. The verdict.
2. The affected accessibility behavior.
3. The first finding and suggested repair, when present.
4. Any missing coverage.

This is an on-demand self-check the assistant runs during implementation. It is
advisory. Do not call the work verified from this command alone. The usabl Stop hook
decides whether Claude can finish.
`;

const OLD_CURSOR_STOP_SCRIPT = `#!/usr/bin/env bash
# Cursor stop hook adapter for usabl.
# Pipes Cursor's stdin through the engine and emits followup_message to loop on block.
# This script is managed by "usabl install --cursor". Manual edits will be detected.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

cat | npx usabl stop-hook --cursor
`;

const OLD_CURSOR_COMMAND = `# usabl-check

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

const OLD_CURSOR_RULE = `---
description: Run usabl accessibility self-checks while editing UI and before claiming work is done
globs: src/**/*.{tsx,jsx,css}
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

function settingsWith(command: string): string {
  return `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }, null, 2)}\n`;
}

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

describe('every generated command runs usabl with npm exec --no', () => {
  const generated: Array<[string, string]> = [
    ['Claude Stop hook command', STOP_HOOK_COMMAND],
    ['usabl-check skill', CLAUDE_SKILL_CONTENTS],
    ['usabl-fix skill', CLAUDE_FIX_SKILL_CONTENTS],
    ['Cursor stop script', CURSOR_STOP_SCRIPT],
    ['Cursor command', CURSOR_COMMAND_CONTENTS],
    ['Cursor rule', buildCursorRuleContents(DEFAULT_CURSOR_UI_FILE_GLOBS)],
  ];

  it.each(generated)('%s never runs npx usabl', (_name, text) => {
    expect(USABL_RUN).toBe('npm exec --no -- usabl');
    expect(text).not.toContain('npx usabl');
    expect(text).toContain(USABL_RUN);
  });

  it('the brief step and the self-check in the skill and the rule use the same form', () => {
    expect(CLAUDE_SKILL_CONTENTS).toContain('`npm exec --no -- usabl brief --json --files <paths>`');
    expect(CLAUDE_SKILL_CONTENTS).toContain(
      'allowed-tools: Bash(npm exec --no -- usabl check --self-check), Bash(npm exec --no -- usabl brief --json --files:*)\n',
    );
    expect(CLAUDE_FIX_SKILL_CONTENTS).toContain('allowed-tools: Bash(npm exec --no -- usabl check --self-check), Read, Edit, Write');
    expect(buildCursorRuleContents(['src/**'])).toContain('`npm exec --no -- usabl brief --json --files <paths>`');
  });

  it('the skills and Cursor files say what to do when usabl is not installed, and never to download it', () => {
    for (const text of [CLAUDE_SKILL_CONTENTS, CLAUDE_FIX_SKILL_CONTENTS, CURSOR_COMMAND_CONTENTS, buildCursorRuleContents(['src/**'])]) {
      expect(text).toContain('usabl is not installed in this project');
      expect(text).toContain('Do not install or download a package named usabl');
    }
  });

  it('the not-installed line is one plain line that says what happened and how to install usabl', () => {
    expect(USABL_NOT_INSTALLED_LINE).not.toContain('\n');
    expect(USABL_NOT_INSTALLED_LINE.startsWith('NOT verified - ')).toBe(true);
    expect(USABL_NOT_INSTALLED_LINE).toContain('usabl is not installed in this project');
    expect(USABL_NOT_INSTALLED_LINE).toContain('npm install --save-dev');
    // It sits inside double quotes in a shell command, so it carries nothing the shell expands.
    expect(USABL_NOT_INSTALLED_LINE).not.toMatch(/["$`\\!]/);
  });
});

// Each case starts a real npm, which takes a few seconds on its own and longer on a busy machine,
// so these cases get the same minute the spawn itself is allowed.
describe('the generated hooks with usabl missing, and with usabl installed', { timeout: 60_000 }, () => {
  let dir = '';
  let emptyPrefix = '';

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'usabl-no-download-')));
    // No global usabl either: npm reads its global folder from this prefix.
    emptyPrefix = join(dir, 'empty-global');
    await mkdir(emptyPrefix);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, npm_config_prefix: emptyPrefix, npm_config_update_notifier: 'false' });

  async function installFakeUsabl(): Promise<void> {
    // A local install as npm lays it out: the package, and its bin linked under node_modules/.bin.
    const pkg = join(dir, 'node_modules', 'usabl');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'usabl', version: '0.0.0', bin: { usabl: 'bin/usabl.js' } }));
    await writeFile(
      join(pkg, 'bin', 'usabl.js'),
      "#!/usr/bin/env node\nlet input = '';\nprocess.stdin.on('data', (c) => (input += c));\nprocess.stdin.on('end', () => { process.stdout.write(`local usabl ${process.argv.slice(2).join(' ')} ${input}`); });\n",
    );
    await chmod(join(pkg, 'bin', 'usabl.js'), 0o755);
    await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink('../usabl/bin/usabl.js', join(dir, 'node_modules', '.bin', 'usabl'));
  }

  it('the Claude Stop hook command fails with one plain line and exit 1 when usabl is missing', () => {
    const ran = spawnSync('sh', ['-c', STOP_HOOK_COMMAND], { cwd: dir, env: env(), input: '{}', encoding: 'utf8', timeout: 60_000 });
    // Exit 1 is a non-blocking hook error in Claude Code: the stop goes on and the user sees the
    // first line of stderr. Exit 2 would block, and exit 0 would read as a pass.
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr.trim()).toBe(USABL_NOT_INSTALLED_LINE);
  });

  it('the Claude Stop hook command runs the local usabl with the stdin it was given', async () => {
    await installFakeUsabl();
    const ran = spawnSync('sh', ['-c', STOP_HOOK_COMMAND], { cwd: dir, env: env(), input: '{"x":1}', encoding: 'utf8', timeout: 60_000 });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('local usabl stop-hook {"x":1}');
    expect(ran.stderr).toBe('');
  });

  it('the Cursor stop script fails with one plain line and exit 1 under set -euo pipefail when usabl is missing', async () => {
    const script = join(dir, 'usabl-stop.sh');
    await writeFile(script, CURSOR_STOP_SCRIPT);
    const ran = spawnSync('bash', [script], { cwd: dir, env: env(), input: '{"loop_count":0}', encoding: 'utf8', timeout: 60_000 });
    // Cursor treats any exit other than 0 and 2 as a failed hook and lets the agent finish.
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr.trim()).toBe(USABL_NOT_INSTALLED_LINE);
  });

  it('the Cursor stop script runs the local usabl with --cursor', async () => {
    await installFakeUsabl();
    const script = join(dir, 'usabl-stop.sh');
    await writeFile(script, CURSOR_STOP_SCRIPT);
    const ran = spawnSync('bash', [script], { cwd: dir, env: env(), input: '{"loop_count":0}', encoding: 'utf8', timeout: 60_000 });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('local usabl stop-hook --cursor {"loop_count":0}');
  });
});

describe('the installers rewrite an old npx usabl file as their own', () => {
  it('usabl install --claude rewrites the old Stop hook command', async () => {
    expect(LEGACY_STOP_HOOK_COMMAND).toBe('npx usabl stop-hook');
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: settingsWith('npx usabl stop-hook') });
    const plan = await planClaude(fs);
    expect(plan).toMatchObject({ action: 'update', reason: 'remove-download' });
    const result = await writeClaude(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(settingsWith(STOP_HOOK_COMMAND));
    expect(result.message).toContain('never downloads');
  });

  it('usabl install --claude still refuses an old command that differs in any other way', async () => {
    const custom = settingsWith('npx usabl stop-hook --verbose');
    const fs = memoryFs({ [CLAUDE_SETTINGS_PATH]: custom });
    const result = await writeClaude(fs, await planClaude(fs));
    expect(result.exitCode).toBe(2);
    expect(fs.store[CLAUDE_SETTINGS_PATH]).toBe(custom);
  });

  it('usabl install --claude-skill rewrites the old skill files', async () => {
    const fs = memoryFs({ [CLAUDE_SKILL_PATH]: OLD_CHECK_SKILL });
    expect(await planClaudeSkill(fs)).toMatchObject({ action: 'rewrite', path: CLAUDE_SKILL_PATH });
    const result = await installClaudeSkills(fs);
    expect(result.exitCode).toBe(0);
    expect(fs.store[CLAUDE_SKILL_PATH]).toBe(CLAUDE_SKILL_CONTENTS);
    expect(fs.store[CLAUDE_FIX_SKILL_PATH]).toBe(CLAUDE_FIX_SKILL_CONTENTS);
    expect(result.message).toContain('never downloads');
  });

  it('usabl install --claude-skill rewrites the old usabl-fix skill', async () => {
    const oldFix = CLAUDE_FIX_SKILL.legacyContents[0];
    expect(oldFix).toBeDefined();
    expect(oldFix).toContain('Bash(npx usabl check --self-check), Read, Edit, Write');
    const fs = memoryFs({ [CLAUDE_FIX_SKILL_PATH]: oldFix ?? '' });
    expect(await planClaudeSkill(fs, CLAUDE_FIX_SKILL)).toMatchObject({ action: 'rewrite' });
  });

  it('usabl install --claude-skill still refuses a skill that differs in any other way', async () => {
    const edited = OLD_CHECK_SKILL.replace('Report:', 'Report, briefly:');
    const fs = memoryFs({ [CLAUDE_SKILL_PATH]: edited });
    const result = await installClaudeSkills(fs);
    expect(result.exitCode).toBe(2);
    expect(fs.store[CLAUDE_SKILL_PATH]).toBe(edited);
  });

  it('usabl install --cursor rewrites the old stop script, command, and rule', async () => {
    const fs = memoryFs({
      [CURSOR_HOOKS_JSON_PATH]: buildCursorHooksJson(null),
      [CURSOR_STOP_SCRIPT_PATH]: OLD_CURSOR_STOP_SCRIPT,
      [CURSOR_COMMAND_PATH]: OLD_CURSOR_COMMAND,
      [CURSOR_RULE_PATH]: OLD_CURSOR_RULE,
    });
    const plan = await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS);
    expect(plan).toMatchObject({ action: 'write' });
    const result = await writeCursor(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(CURSOR_STOP_SCRIPT);
    expect(fs.store[CURSOR_COMMAND_PATH]).toBe(CURSOR_COMMAND_CONTENTS);
    expect(fs.store[CURSOR_RULE_PATH]).toBe(buildCursorRuleContents(DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.message).toContain('never downloads');
  });

  it('usabl install --cursor still refuses an old stop script that differs in any other way', async () => {
    const edited = OLD_CURSOR_STOP_SCRIPT.replace('set -euo pipefail', 'set -eu');
    const fs = memoryFs({ [CURSOR_STOP_SCRIPT_PATH]: edited });
    const result = await writeCursor(fs, await planCursor(fs, DEFAULT_CURSOR_UI_FILE_GLOBS));
    expect(result.exitCode).toBe(2);
    expect(fs.store[CURSOR_STOP_SCRIPT_PATH]).toBe(edited);
  });
});

describe('usabl doctor reports an old npx usabl file as a security drift', () => {
  function readOnly(files: Record<string, string>): InstallFs {
    const fs = memoryFs(files);
    return {
      readFile: fs.readFile,
      glob: fs.glob,
      writeFile: async () => {
        throw new Error('doctor must never write');
      },
    };
  }

  async function report(files: Record<string, string>) {
    const reports = await collectDoctorReport({
      fs: readOnly(files),
      gh: { getJson: async () => null },
      configPath: 'usabl.config.json',
      env: {},
      probePlaywrightChromium: async () => 'wired',
      probeChromiumSandbox: async () => 'available',
    });
    return (id: string) => {
      const found = reports.find((entry) => entry.id === id);
      if (found === undefined) {
        throw new Error(`no report ${id}`);
      }
      return found;
    };
  }

  it('names the Stop hook and the reinstall command', async () => {
    const byId = await report({ [CLAUDE_SETTINGS_PATH]: settingsWith('npx usabl stop-hook') });
    expect(byId('stop-hook').state).toBe('drifted');
    expect(byId('stop-hook').nextStep).toContain('Security drift');
    expect(byId('stop-hook').nextStep).toContain('usabl install --claude');
  });

  it('names an old skill and the reinstall command', async () => {
    const byId = await report({ [CLAUDE_SKILL_PATH]: OLD_CHECK_SKILL });
    expect(byId('claude-skill:usabl-check').state).toBe('drifted');
    expect(byId('claude-skill:usabl-check').nextStep).toContain('Security drift');
    expect(byId('claude-skill:usabl-check').nextStep).toContain('usabl install --claude-skill');
  });

  it('names old Cursor files and the reinstall command', async () => {
    const byId = await report({
      [CURSOR_HOOKS_JSON_PATH]: buildCursorHooksJson(null),
      [CURSOR_STOP_SCRIPT_PATH]: OLD_CURSOR_STOP_SCRIPT,
      [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
      [CURSOR_RULE_PATH]: buildCursorRuleContents(DEFAULT_CURSOR_UI_FILE_GLOBS),
    });
    expect(byId('cursor').state).toBe('drifted');
    expect(byId('cursor').nextStep).toContain('Security drift');
    expect(byId('cursor').nextStep).toContain(CURSOR_STOP_SCRIPT_PATH);
    expect(byId('cursor').nextStep).toContain('usabl install --cursor');
  });

  it('still reports the current files as wired', async () => {
    const byId = await report({
      [CLAUDE_SETTINGS_PATH]: settingsWith(STOP_HOOK_COMMAND),
      [CLAUDE_SKILL_PATH]: CLAUDE_SKILL_CONTENTS,
    });
    expect(byId('stop-hook').state).toBe('wired');
    expect(byId('claude-skill:usabl-check').state).toBe('wired');
  });
});
