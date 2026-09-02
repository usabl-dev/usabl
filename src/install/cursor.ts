/**
 * Cursor assistant install generator for `usabl install --cursor`.
 * It writes the on-demand /usabl-check slash command and a UI-scoped rule that reminds the
 * agent to run the advisory self-check during implementation. This is a whole-file draft for
 * each path: absent path, write the complete file; identical files, no-op; a file that differs,
 * refuse. The paths are usabl-owned, but a differing file may be an operator edit or an older
 * engine version, so the generator refuses rather than clobber it.
 */
import type { InstallFs, InstallResult } from './index.js';

export const CURSOR_COMMAND_PATH = '.cursor/commands/usabl-check.md';
export const CURSOR_RULE_PATH = '.cursor/rules/usabl-accessibility.mdc';

export const CURSOR_COMMAND_CONTENTS = `# usabl-check

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

export const CURSOR_RULE_CONTENTS = `---
description: Run usabl accessibility self-checks while editing UI and before claiming work is done
globs: src/**/*.{tsx,jsx,css}
alwaysApply: false
---

# usabl accessibility workflow

When changing user interface code:

- After a meaningful UI change, run \`/usabl-check\` or \`npx usabl check --self-check\` from the repository root.
- Treat usabl findings as the source of truth for machine-checkable barriers.
- Explain verdicts honestly: \`verified\`, \`regression\`, \`not_covered\`, or \`approval_required\`.
- Do not call work verified from the self-check alone. The gate (\`usabl check\` / CI) decides proof.
- Prefer fixing source over query-parameter previews or disabling checks.
`;

const CURSOR_FILES = [
  { path: CURSOR_COMMAND_PATH, draft: CURSOR_COMMAND_CONTENTS },
  { path: CURSOR_RULE_PATH, draft: CURSOR_RULE_CONTENTS },
] as const;

export type CursorPlan =
  | { action: 'write'; files: Array<{ path: string; draft: string }> }
  | { action: 'already-wired'; paths: string[] }
  | { action: 'refuse'; path: string };

export async function planCursor(fs: InstallFs): Promise<CursorPlan> {
  const existing: Array<{ path: string; draft: string; contents: string | null }> = [];
  for (const file of CURSOR_FILES) {
    existing.push({ ...file, contents: await fs.readFile(file.path) });
  }

  const missing = existing.filter((file) => file.contents === null);
  if (missing.length === CURSOR_FILES.length) {
    return { action: 'write', files: CURSOR_FILES.map((file) => ({ path: file.path, draft: file.draft })) };
  }

  for (const file of existing) {
    if (file.contents !== null && file.contents !== file.draft) {
      return { action: 'refuse', path: file.path };
    }
  }

  if (missing.length > 0) {
    return {
      action: 'write',
      files: missing.map((file) => ({ path: file.path, draft: file.draft })),
    };
  }

  return { action: 'already-wired', paths: CURSOR_FILES.map((file) => file.path) };
}

function cursorRefusalMessage(path: string): string {
  return [
    `Refusing to overwrite ${path}: it exists but is not the canonical usabl Cursor wiring.`,
    'If it is an older usabl Cursor install, delete the file and re-run "usabl install --cursor".',
    'If you edited it on purpose, keep your version; usabl will not clobber it.',
  ].join('\n');
}

export async function writeCursor(fs: InstallFs, plan: CursorPlan): Promise<InstallResult> {
  if (plan.action === 'write') {
    for (const file of plan.files) {
      await fs.writeFile(file.path, file.draft);
    }
    const paths = plan.files.map((file) => file.path).join(', ');
    return {
      exitCode: 0,
      action: 'written',
      path: plan.files[0]?.path ?? CURSOR_COMMAND_PATH,
      message: `Wrote ${paths}. Review these drafts before you merge them.`,
    };
  }
  if (plan.action === 'already-wired') {
    return {
      exitCode: 0,
      action: 'already-wired',
      path: CURSOR_COMMAND_PATH,
      message: `Cursor assistant wiring is already present at ${plan.paths.join(' and ')}. No change.`,
    };
  }
  return {
    exitCode: 2,
    action: 'refused',
    path: plan.path,
    message: cursorRefusalMessage(plan.path),
  };
}
