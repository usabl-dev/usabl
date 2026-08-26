import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function failure(label, result) {
  return `${label} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

const workspace = await mkdtemp(join(tmpdir(), 'usabl-package-smoke-'));

try {
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', workspace]);
  assert.equal(packed.status, 0, failure('npm pack', packed));
  const report = JSON.parse(packed.stdout);
  const filename = report[0]?.filename;
  assert.equal(typeof filename, 'string', 'npm pack did not report an archive filename');

  const consumer = join(workspace, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'usabl-package-consumer', private: true, type: 'module' }, null, 2) + '\n',
  );

  const installed = run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(workspace, filename)],
    { cwd: consumer },
  );
  assert.equal(installed.status, 0, failure('package install', installed));

  await writeFile(
    join(consumer, 'usabl.config.json'),
    JSON.stringify(
      {
        appBaseUrl: 'http://127.0.0.1:5173',
        uiFileGlobs: ['src/**'],
        discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
        surfaces: [],
        guardedPaths: [],
      },
      null,
      2,
    ) + '\n',
  );

  const setupCommands = [
    ['git', ['init', '--quiet']],
    ['git', ['config', 'user.name', 'usabl package smoke']],
    ['git', ['config', 'user.email', 'package-smoke@usabl.invalid']],
    ['git', ['add', 'package.json', 'package-lock.json', 'usabl.config.json']],
    ['git', ['commit', '--quiet', '-m', 'test: seed package consumer']],
  ];
  for (const [command, args] of setupCommands) {
    const result = run(command, args, { cwd: consumer });
    assert.equal(result.status, 0, failure(`${command} ${args.join(' ')}`, result));
  }

  const cli = join(consumer, 'node_modules', 'usabl', 'dist', 'cli.js');
  const checked = run(process.execPath, [cli, 'check', '--json'], { cwd: consumer });
  assert.equal(checked.status, 0, failure('installed usabl check', checked));
  assert.notEqual(checked.stdout.trim(), '', 'installed usabl check produced no Result JSON');

  const result = JSON.parse(checked.stdout);
  assert.equal(result.schemaVersion, 'usabl.result.v1');
  assert.equal(result.verdict, null);
  assert.equal(result.coverage.nothingToCheck, true);
  assert.equal(result.exitCode, 0);

  const checkedWithNpx = run('npx', ['--no-install', 'usabl', 'check', '--json'], { cwd: consumer });
  assert.equal(checkedWithNpx.status, 0, failure('installed npx usabl check', checkedWithNpx));
  assert.deepEqual(JSON.parse(checkedWithNpx.stdout), result);

  const commented = run(process.execPath, [cli, 'comment'], {
    cwd: consumer,
    input: checked.stdout,
  });
  assert.equal(commented.status, 0, failure('installed usabl comment', commented));
  assert.match(commented.stdout, /<!-- usabl-report -->/);
  assert.match(commented.stdout, /## usabl report: IDLE/);

  const refused = run(process.execPath, [cli, 'check', '--ci'], { cwd: consumer });
  assert.equal(refused.status, 2, failure('installed usabl CI refusal', refused));
  assert.match(refused.stderr, /CI mode requires --trusted-ref/);

  process.stdout.write('usabl package smoke: installed CLI produced, projected, and enforced a Result.\n');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
