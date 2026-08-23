/**
 * Shared glob matcher for planner and in-memory fakes.
 * One glob dialect keeps coverage planning and tests aligned on which files are UI.
 * This unit must never read files or infer coverage by itself.
 */
export function matchGlob(pattern: string, file: string): boolean {
  // Encode **/? first so src/**/*.tsx matches src/App.tsx and deeper files.
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') +
      '$',
  );
  return rx.test(file);
}
