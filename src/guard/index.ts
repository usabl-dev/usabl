import type { Deps } from '../contracts/index.js';

/**
 * Local tamper-evident guard, not tamper-proof. CI is the tamper-proof tier.
 * A path diverges when working-tree bytes are not exactly HEAD bytes (including
 * a file that exists only on one side). Byte compare, no parse, no "looks safe."
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
