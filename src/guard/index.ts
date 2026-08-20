import type { Deps } from '../contracts/index.js';

/**
 * Local tamper-evident guard: a guarded path diverges when its working-tree content
 * does not exactly equal its HEAD content (including being absent from HEAD).
 * Config-guards-itself ordering and session pinning are added in Phase 3.
 */
export async function computeGuardDivergence(deps: Deps, guardedPaths: string[]): Promise<string[]> {
  const diverged: string[] = [];
  for (const path of guardedPaths) {
    const [working, head] = await Promise.all([deps.fs.readFile(path), deps.git.show('HEAD', path)]);
    if (working === null && head === null) continue; // guarded path not present anywhere: nothing to compare
    if (working !== head) diverged.push(path);
  }
  return diverged.sort();
}
