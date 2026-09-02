/**
 * Claude skill install generator for `usabl install --claude-skill`.
 * It writes the on-demand /usabl-check command as a Claude Code skill file, so the advisory
 * self-check ships with the engine instead of being hand-copied into each consumer repo.
 * This is a whole-file draft, like the overlay generator: absent path, write the complete
 * file; identical file, no-op; a file that differs, refuse. The path is usabl-owned, but a
 * differing file may be an operator edit or an older engine version, and proving a lossless
 * merge of an arbitrary skill file from text alone is not something this generator claims.
 * A refusal that names the file and the manual step is safer than clobbering operator work.
 * It mirrors the install family contract: it writes a draft a human reviews, mints no verdict,
 * never calls the gate, and never reads a verdict.
 */
import type { InstallFs, InstallResult } from './index.js';

// The skill file the /usabl-check command lives in. The nested folders are created by the
// install filesystem before the write, the same way the .claude and .github/workflows
// parents are created for the Stop hook and the CI gate.
export const CLAUDE_SKILL_PATH = '.claude/skills/usabl-check/SKILL.md';

// The canonical skill body. allowed-tools restricts the command to the advisory self-check
// flag, so the installed skill can never run anything but "npx usabl check --self-check". The
// closing paragraph keeps the honesty invariant on the skill's face: this command is advisory
// and never verifies work; the Stop hook is the only thing that decides Claude can finish.
export const CLAUDE_SKILL_CONTENTS = `---
name: usabl-check
description: Run the advisory usabl accessibility check during implementation and explain the current result.
allowed-tools: Bash(npx usabl check --self-check)
---

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

export type ClaudeSkillPlan =
  | { action: 'write'; path: string; draft: string }
  | { action: 'already-wired'; path: string }
  | { action: 'refuse'; path: string };

export async function planClaudeSkill(fs: InstallFs): Promise<ClaudeSkillPlan> {
  const existing = await fs.readFile(CLAUDE_SKILL_PATH);
  if (existing === null) {
    // No skill file, so a full draft is safe to write.
    return { action: 'write', path: CLAUDE_SKILL_PATH, draft: CLAUDE_SKILL_CONTENTS };
  }
  if (existing === CLAUDE_SKILL_CONTENTS) {
    // Byte-identical to the canonical skill: nothing to do.
    return { action: 'already-wired', path: CLAUDE_SKILL_PATH };
  }
  // Present but different. It could be an operator edit or an older engine version; either
  // way, overwriting it would be lossy, so refuse and hand over the manual step instead.
  return { action: 'refuse', path: CLAUDE_SKILL_PATH };
}

function claudeSkillRefusalMessage(path: string): string {
  return [
    `Refusing to overwrite ${path}: it exists but is not the canonical usabl-check skill.`,
    'If it is an older usabl-check skill, delete it and re-run "usabl install --claude-skill".',
    'If you edited it on purpose, keep your version; usabl will not clobber it.',
  ].join('\n');
}

export async function writeClaudeSkill(fs: InstallFs, plan: ClaudeSkillPlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    await fs.writeFile(plan.path, plan.draft);
    return {
      exitCode: 0,
      action: 'written',
      path: plan.path,
      message: `Wrote ${plan.path} with the usabl-check skill. Review this draft before you merge it.`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: plan.path,
      message: `${plan.path} already holds the canonical usabl-check skill. No change.`,
    };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: claudeSkillRefusalMessage(plan.path),
  };
}
