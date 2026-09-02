/**
 * The Claude skill generator wires the on-demand /usabl-check command as a whole-file draft.
 * Like the overlay generator it either writes a complete file, no-ops when the file already
 * matches, or refuses to touch a file that differs. The skill file lives at a usabl-owned
 * path, but a differing file may be an operator edit or an older engine version, so the
 * generator refuses rather than clobber it. The refusal guard is asserted to be load-bearing:
 * if the generator ever overwrote a differing file, the untouched-bytes assertion flips red.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  CLAUDE_SKILL_CONTENTS,
  CLAUDE_SKILL_PATH,
  planClaudeSkill,
  writeClaudeSkill,
} from '../../src/install/claude-skill.js';

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

describe('CLAUDE_SKILL_CONTENTS', () => {
  it('declares the usabl-check skill and pins the advisory self-check command', () => {
    // The frontmatter must name the skill and restrict its one tool to the advisory self-check
    // flag, so the installed command can never run anything but "npx usabl check --self-check".
    expect(CLAUDE_SKILL_PATH).toBe('.claude/skills/usabl-check/SKILL.md');
    expect(CLAUDE_SKILL_CONTENTS).toContain('name: usabl-check');
    expect(CLAUDE_SKILL_CONTENTS).toContain('allowed-tools: Bash(npx usabl check --self-check)');
    expect(CLAUDE_SKILL_CONTENTS).toContain('npx usabl check --self-check');
  });

  it('states the skill is advisory and that the Stop hook is the gate', () => {
    // The body must keep the honesty invariant on its face: this command never verifies work;
    // the Stop hook decides whether Claude can finish. Losing that line would let the skill
    // read as a gate it is not.
    expect(CLAUDE_SKILL_CONTENTS.toLowerCase()).toContain('advisory');
    expect(CLAUDE_SKILL_CONTENTS).toContain('Stop hook');
  });
});

describe('planClaudeSkill', () => {
  it('plans a full draft when the skill file is absent', async () => {
    const plan = await planClaudeSkill(memoryFs({}));
    expect(plan.action).toBe('write');
    expect(plan.path).toBe(CLAUDE_SKILL_PATH);
    if (plan.action === 'write') {
      expect(plan.draft).toBe(CLAUDE_SKILL_CONTENTS);
    }
  });

  it('reports already wired when the file already matches the canonical skill', async () => {
    const plan = await planClaudeSkill(memoryFs({ [CLAUDE_SKILL_PATH]: CLAUDE_SKILL_CONTENTS }));
    expect(plan.action).toBe('already-wired');
    expect(plan.path).toBe(CLAUDE_SKILL_PATH);
  });

  it('refuses when a different file already occupies the skill path', async () => {
    const plan = await planClaudeSkill(
      memoryFs({ [CLAUDE_SKILL_PATH]: '---\nname: usabl-check\n---\n\nOperator edit.\n' }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.path).toBe(CLAUDE_SKILL_PATH);
  });
});

describe('writeClaudeSkill', () => {
  it('writes the draft when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({});
    const first = await writeClaudeSkill(fs, await planClaudeSkill(fs));
    expect(first.exitCode).toBe(0);
    expect(first.action).toBe('written');
    expect(fs.store[CLAUDE_SKILL_PATH]).toBe(CLAUDE_SKILL_CONTENTS);

    const second = await writeClaudeSkill(fs, await planClaudeSkill(fs));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
    expect(fs.store[CLAUDE_SKILL_PATH]).toBe(CLAUDE_SKILL_CONTENTS);
  });

  it('refuses without touching an operator file that differs', async () => {
    const original = '---\nname: usabl-check\n---\n\nOperator edit.\n';
    const fs = memoryFs({ [CLAUDE_SKILL_PATH]: original });
    const result = await writeClaudeSkill(fs, await planClaudeSkill(fs));

    // Load-bearing guard: exit 2 and the original bytes stay untouched. If the generator ever
    // overwrote a differing skill file, both assertions flip red.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store[CLAUDE_SKILL_PATH]).toBe(original);
    // The refusal must name the path and the manual step so an operator can reconcile by hand.
    expect(result.message).toContain(CLAUDE_SKILL_PATH);
  });
});
