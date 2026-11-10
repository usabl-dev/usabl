// Records which commit this build came from, in dist/build-info.json. `usabl install --ci` reads it
// to pin the engine in the workflows it writes. The commit counts only when it is a full SHA and
// the tree had no uncommitted or untracked change, because only then is the commit the code that
// was built. Outside git the commit is null. The installer keeps the placeholder in both cases.
//
// Usage: node scripts/write-build-info.mjs [repository directory] [output file]
// Defaults: the repository this script is in, and its dist/build-info.json.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(process.argv[2] ?? here);
const out = resolve(process.argv[3] ?? join(repo, 'dist', 'build-info.json'));

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const head = git(['rev-parse', '--verify', 'HEAD'])?.trim() ?? '';
const commit = /^[0-9a-f]{40}$/.test(head) ? head : null;
// Untracked files count, because the build may have read them. Ignored files, such as dist and
// node_modules, do not.
const status = commit === null ? null : git(['status', '--porcelain', '--untracked-files=all']);
const clean = status !== null && status.trim() === '';

const info = { schemaVersion: 'usabl.build-info.v1', version: pkg.version, commit, clean };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
process.stdout.write(
  commit === null
    ? 'usabl build info: no git commit, so usabl install --ci will keep the engine pin placeholder.\n'
    : `usabl build info: commit ${commit}, ${clean ? 'clean tree' : 'tree with changes, so usabl install --ci will keep the engine pin placeholder'}.\n`,
);
