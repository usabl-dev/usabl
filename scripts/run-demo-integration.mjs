/**
 * Builds the engine and runs the demo app integration suites under one lock.
 *
 * The suites load `usabl/vite` from this repository's `dist/`, and the build
 * cleans `dist/` first. Two overlapping runs in the same checkout could therefore
 * empty `dist/` under each other and fail for no real reason. This script holds an
 * exclusive lock file for the whole build-and-run. A second run fails fast and
 * names the process holding the lock. A lock left by a dead process is replaced.
 *
 * Usage: USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 * Extra arguments are passed to Vitest (for example one test file path).
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(repoRoot, '.demo-integration.lock');
const BUILD_TIMEOUT_MS = 5 * 60_000;
// The suites bound their own waits; this is only a ceiling for a hung runner.
const TEST_TIMEOUT_MS = 30 * 60_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      if (Number.isInteger(holder) && processAlive(holder)) {
        process.stderr.write(
          `another demo integration run (pid ${holder}) holds ${lockPath}; wait for it to finish, or remove the file if that process is not a test run\n`,
        );
        process.exit(3);
      }
      // The holder is gone. Take over its lock and retry once.
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire ${lockPath}`);
}

function releaseLock() {
  try {
    if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone.
  }
}

function runStep(label, command, args, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', env });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with ${code ?? signal}`));
      }
    });
  });
}

acquireLock();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    releaseLock();
    process.exit(130);
  });
}

try {
  await runStep('npm run build', 'npm', ['run', 'build'], BUILD_TIMEOUT_MS, process.env);
  await runStep(
    'vitest',
    'npx',
    ['vitest', 'run', '--config', 'vitest.demo.config.ts', ...process.argv.slice(2)],
    TEST_TIMEOUT_MS,
    { ...process.env, USABL_INTEGRATION: '1' },
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  releaseLock();
}
