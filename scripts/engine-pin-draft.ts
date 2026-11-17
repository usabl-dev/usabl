// The gate that `usabl install --ci` writes at a pinned commit, built from that commit's own source.
// The checked-in gate is compared with this draft, never with the draft in the working tree, so a
// pull request that changes the gate template does not break the gate that the pin still names.
//
// The pinned commit's src/ is extracted with git archive into a new folder under .work/ in the
// repository, so its bare imports resolve to the repository's node_modules. Its src/install/ci.ts
// is imported, the draft is pinned with that commit's own pinEngineRef, and the folder is removed.
// Run it under vite-node or vitest, which load TypeScript. The pin must already be known to be a
// commit on main, because this runs the pinned commit's code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMMIT_ID } from './engine-pin.js';

const PREFIX = 'usabl engine pin:';

export async function draftGateAtPin(pin: string, root = '.'): Promise<string> {
  if (!COMMIT_ID.test(pin)) {
    throw new Error(`${PREFIX} the pin is not a full lowercase commit id, so there is no commit to build the draft from.`);
  }
  const repo = resolve(root);
  const known = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${pin}^{commit}`]);
  if (known.status !== 0) {
    throw new Error(
      `${PREFIX} commit ${pin} is not in this clone, so the gate cannot be compared with the draft that commit writes. Fetch the full history of main and run the check again.`,
    );
  }
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '--end-of-options', pin, 'src'], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) {
    throw new Error(`${PREFIX} git could not read src/ at commit ${pin}, so the gate cannot be compared with the draft that commit writes.`);
  }
  const parent = join(repo, '.work', 'engine-pin-src');
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'pin-'));
  try {
    const untar = spawnSync('tar', ['-x', '-C', folder], { input: archive.stdout });
    if (untar.status !== 0) {
      throw new Error(`${PREFIX} the source at commit ${pin} could not be unpacked, so the gate cannot be compared with its draft.`);
    }
    const installer = (await import(join(folder, 'src', 'install', 'ci.ts'))) as Record<string, unknown>;
    const draft = installer['USABL_GATE_WORKFLOW'];
    const pinEngineRef = installer['pinEngineRef'];
    if (typeof draft !== 'string' || typeof pinEngineRef !== 'function') {
      throw new Error(`${PREFIX} the installer at commit ${pin} has no gate draft usabl can read, so the gate cannot be compared with it.`);
    }
    const pinned: unknown = pinEngineRef(draft, pin);
    if (typeof pinned !== 'string') {
      throw new Error(`${PREFIX} the installer at commit ${pin} did not return a pinned gate.`);
    }
    return pinned;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
