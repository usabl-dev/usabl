/**
 * Shared shapes for the install family of draft generators.
 * Each generator wires one integration point (Vite overlay, Claude Stop hook, CI gate,
 * branch protection) from the working tree. These generators write DRAFTS a human
 * reviews and merges. They must never mint a verdict, never call the gate, never read a
 * verdict, and never consume a file they just wrote in the same run. On ambiguous input
 * they refuse and print the exact manual step, because a wrong or lossy output is worse
 * than an honest refusal.
 */

// The same three-method port the init generator uses, so install tests can reuse the
// in-memory fake fs pattern and never touch the real tree or its guarded paths.
export interface InstallFs {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
  writeFile(path: string, contents: string): Promise<void>;
}

// The honest outcomes a file-writing generator can reach. Only `written` mutates the tree.
export type InstallAction = 'written' | 'already-wired' | 'refused';

export interface InstallResult {
  // 0 = draft written or already wired; 2 = refusal that needs a manual step.
  exitCode: 0 | 2;
  action: InstallAction;
  path: string;
  message: string;
}

// One report formatter for the whole family. The result already carries the full
// message, including any manual step, so wiring in cli.ts stays as thin as init's.
export function formatInstallReport(result: { message: string }): string {
  return `${result.message}\n`;
}
