/**
 * Unit tests for the demo-app fixture cleanup. They use a fake process inspector
 * and a private temp root, so they run in the default suite without the demo app.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLONE_PREFIX,
  OWNER_FILE,
  createOwnedRoot,
  decideOrphanedServer,
  parseOwner,
  removeClonesOfStoppedRun,
  removeStaleClones,
  type OwnerRecord,
  type ProcessInspector,
} from './fixture-app.js';

let tmpRoot = '';

interface FakeProcess {
  pgid: number;
  cwd: string | null;
}

function fakeInspector(processes: Record<number, FakeProcess>): ProcessInspector & { killed: Array<[number, string]> } {
  const killed: Array<[number, string]> = [];
  return {
    killed,
    alive(target) {
      if (target < 0) {
        return Object.values(processes).some((entry) => entry.pgid === -target);
      }
      return target in processes;
    },
    async groupMembers(pgid) {
      return Object.entries(processes)
        .filter(([, entry]) => entry.pgid === pgid)
        .map(([pid]) => Number(pid));
    },
    async cwdOf(pid) {
      return processes[pid]?.cwd ?? null;
    },
    kill(target, signal) {
      killed.push([target, signal]);
      for (const [pid, entry] of Object.entries(processes)) {
        if (entry.pgid === -target) {
          delete processes[Number(pid)];
        }
      }
    },
  };
}

/**
 * How far back a clone of age zero is stamped. The cleanup keeps any clone whose
 * mtime is at or after the moment the scan starts. A clone stamped with the exact
 * current millisecond lands on the keep side of that line whenever the stamp and the
 * scan fall in the same millisecond, which happens often. Stamping a hair earlier
 * makes "age zero" mean "made just before the call", which is what every test here
 * means by it, and takes the millisecond out of the result.
 */
const JUST_BEFORE_MS = 5;

async function makeClone(name: string, owner: OwnerRecord | string | null, ageMs: number): Promise<string> {
  const root = join(tmpRoot, `${CLONE_PREFIX}${name}`);
  await mkdir(join(root, 'app'), { recursive: true });
  if (owner !== null) {
    await writeFile(join(root, OWNER_FILE), typeof owner === 'string' ? owner : JSON.stringify(owner), 'utf8');
  }
  const then = (Date.now() - ageMs - JUST_BEFORE_MS) / 1000;
  await utimes(root, then, then);
  return root;
}

/** A promise and the function that settles it, so a test can hold a step and release it. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'usabl-cleanup-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('orphaned server decision', () => {
  const owner: OwnerRecord = { pid: 10, startedAt: 0, cwd: '/tmp/clone-x/app', serverPid: 500 };

  it('kills the group when every live member works inside the clone', async () => {
    const inspector = fakeInspector({
      500: { pgid: 500, cwd: '/tmp/clone-x/app' },
      501: { pgid: 500, cwd: '/tmp/clone-x/app/node_modules/.vite' },
    });
    await expect(decideOrphanedServer(owner, inspector)).resolves.toEqual({ action: 'kill', members: [500, 501] });
  });

  it('leaves a group whose member works elsewhere, even when its leader matches', async () => {
    const inspector = fakeInspector({
      500: { pgid: 500, cwd: '/tmp/clone-x/app' },
      777: { pgid: 500, cwd: '/home/someone/project' },
    });
    const decision = await decideOrphanedServer(owner, inspector);
    expect(decision.action).toBe('leave');
    expect(decision.action === 'leave' && decision.reason).toContain('777');
  });

  it('leaves a group whose member has no readable working directory', async () => {
    const inspector = fakeInspector({ 500: { pgid: 500, cwd: null } });
    await expect(decideOrphanedServer(owner, inspector)).resolves.toMatchObject({ action: 'leave' });
  });

  it('does nothing when the group is gone or no server was recorded', async () => {
    await expect(decideOrphanedServer(owner, fakeInspector({}))).resolves.toMatchObject({ action: 'none' });
    const noServer: OwnerRecord = { pid: owner.pid, startedAt: owner.startedAt, cwd: owner.cwd };
    await expect(decideOrphanedServer(noServer, fakeInspector({}))).resolves.toMatchObject({ action: 'none' });
  });

  it('does not treat a clone path prefix as inside the clone', async () => {
    const inspector = fakeInspector({ 500: { pgid: 500, cwd: '/tmp/clone-x/app-other' } });
    await expect(decideOrphanedServer(owner, inspector)).resolves.toMatchObject({ action: 'leave' });
  });
});

describe('stale clone removal', () => {
  const hour = 60 * 60 * 1000;

  it('removes an old clone whose owner is dead and kills its orphaned server group', async () => {
    const root = await makeClone('dead', { pid: 10, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}dead`, 'app'), serverPid: 500 }, hour);
    const inspector = fakeInspector({ 500: { pgid: 500, cwd: join(root, 'app') } });
    const log: string[] = [];
    const removed = await removeStaleClones({ tmpRoot, inspector, processStartedAt: Date.now(), log: (line) => log.push(line) });
    expect(removed).toEqual([root]);
    expect(inspector.killed).toEqual([[-500, 'SIGKILL']]);
    await expect(exists(root)).resolves.toBe(false);
  });

  it('leaves a clone whose owner is alive', async () => {
    const root = await makeClone('live', { pid: 10, startedAt: 0, cwd: join(tmpRoot, 'x') }, hour);
    const inspector = fakeInspector({ 10: { pgid: 10, cwd: '/anywhere' } });
    await expect(removeStaleClones({ tmpRoot, inspector, processStartedAt: Date.now(), log: () => {} })).resolves.toEqual([]);
    await expect(exists(root)).resolves.toBe(true);
  });

  it('leaves a clone younger than this process', async () => {
    const root = await makeClone('young', { pid: 10, startedAt: 0, cwd: join(tmpRoot, 'x') }, 0);
    const removed = await removeStaleClones({ tmpRoot, inspector: fakeInspector({}), processStartedAt: Date.now() - hour, log: () => {} });
    expect(removed).toEqual([]);
    await expect(exists(root)).resolves.toBe(true);
  });

  it('never removes a clone without a valid owner file, and says so', async () => {
    const missing = await makeClone('noowner', null, hour);
    const corrupt = await makeClone('corrupt', '{"pid":"not a number"}', hour);
    const log: string[] = [];
    const removed = await removeStaleClones({ tmpRoot, inspector: fakeInspector({}), processStartedAt: Date.now(), log: (line) => log.push(line) });
    expect(removed).toEqual([]);
    await expect(exists(missing)).resolves.toBe(true);
    await expect(exists(corrupt)).resolves.toBe(true);
    expect(log.filter((line) => line.includes('left in place'))).toHaveLength(2);
  });

  it('removes the clone but leaves a server group that works outside it', async () => {
    const root = await makeClone('foreign', { pid: 10, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}foreign`, 'app'), serverPid: 500 }, hour);
    const inspector = fakeInspector({ 500: { pgid: 500, cwd: '/home/someone/project' } });
    const log: string[] = [];
    const removed = await removeStaleClones({ tmpRoot, inspector, processStartedAt: Date.now(), log: (line) => log.push(line) });
    expect(removed).toEqual([root]);
    expect(inspector.killed).toEqual([]);
    expect(log.some((line) => line.includes('left running'))).toBe(true);
  });
});

describe('clones of a stopped run', () => {
  it('removes every clone whose owner died with the stopped group, even ones younger than this process', async () => {
    // Two clones from the killed Vitest group (owner pids 20 and 21 are dead), one from a concurrent run (owner 30 alive).
    const first = await makeClone('stopped-a', { pid: 20, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}stopped-a`, 'app'), serverPid: 600 }, 0);
    const second = await makeClone('stopped-b', { pid: 21, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}stopped-b`, 'app'), serverPid: 601 }, 0);
    const concurrent = await makeClone('concurrent', { pid: 30, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}concurrent`, 'app') }, 0);
    const inspector = fakeInspector({ 30: { pgid: 30, cwd: '/somewhere/else' } });
    const reported: string[] = [];

    const result = await removeClonesOfStoppedRun({ tmpRoot, inspector, timeoutMs: 5_000, log: () => {}, onRemoved: (root) => reported.push(root) });

    expect(result.timedOut).toBe(false);
    expect([...result.removed].sort()).toEqual([first, second].sort());
    expect([...reported].sort()).toEqual([first, second].sort());
    expect(inspector.killed).toEqual([]);
    await expect(exists(first)).resolves.toBe(false);
    await expect(exists(second)).resolves.toBe(false);
    await expect(exists(concurrent)).resolves.toBe(true);
  });

  it('stops waiting at the bound and reports what it removed so far', async () => {
    // Pins the bound: when one clone is still being removed as the bound arrives, the helper
    // returns, says it timed out, and reports only the clones it has already removed.
    //
    // Nothing here waits on the clock. The slow clone is held on a promise this test releases,
    // and the bound is a promise this test settles the moment the quick clone is gone, so the
    // result is taken at a known point on any machine. Do not put a real sleep back.
    const quick = await makeClone('quick', { pid: 20, startedAt: 0, cwd: join(tmpRoot, `${CLONE_PREFIX}quick`, 'app') }, 0);
    const stuckRoot = join(tmpRoot, `${CLONE_PREFIX}stuck`);
    await makeClone('stuck', { pid: 21, startedAt: 0, cwd: join(stuckRoot, 'app'), serverPid: 700 }, 0);
    const inspector = fakeInspector({ 700: { pgid: 700, cwd: join(stuckRoot, 'app') } });

    // The stuck clone's server group does not answer until this test lets it, which is what
    // keeps that clone's removal in flight while the bound arrives.
    const stuckAnswers = deferred();
    const answerGroup = inspector.groupMembers;
    inspector.groupMembers = async (pgid) => {
      await stuckAnswers.promise;
      return answerGroup(pgid);
    };

    const boundReached = deferred();
    const stuckRemoved = deferred();

    const result = await removeClonesOfStoppedRun({
      tmpRoot,
      inspector,
      timeoutMs: 200,
      log: () => {},
      onRemoved: (root) => (root === quick ? boundReached.release() : stuckRemoved.release()),
      waitForBound: () => boundReached.promise,
    });

    expect(result.timedOut).toBe(true);
    expect(result.removed).toEqual([quick]);
    await expect(exists(quick)).resolves.toBe(false);

    // Let the held clone finish, so no work is left running past the end of this test.
    stuckAnswers.release();
    await stuckRemoved.promise;
  });
});

describe('owned root creation', () => {
  it('renames a pending directory that already holds the owner file into place', async () => {
    const { root, cwd } = await createOwnedRoot(tmpRoot, { pid: 4242, startedAt: 7 });
    expect(root.startsWith(join(tmpRoot, CLONE_PREFIX))).toBe(true);
    expect(cwd).toBe(join(root, 'app'));
    const owner = parseOwner(await readFile(join(root, OWNER_FILE), 'utf8'));
    expect(owner).toEqual({ pid: 4242, startedAt: 7, cwd });
    await expect(readdir(tmpRoot)).resolves.toEqual([root.slice(tmpRoot.length + 1)]);
  });
});
