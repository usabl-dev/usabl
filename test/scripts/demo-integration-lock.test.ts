import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  readLockRecord,
  releaseLock,
  updateLock,
  YOUNG_LOCK_MS,
  type LockDeps,
} from '../../scripts/demo-integration-lock.js';

let dir = '';
let lockPath = '';

function deps(overrides: Partial<LockDeps> = {}): LockDeps {
  return {
    pid: 4242,
    nonce: 'nonce-a',
    now: () => 1_000_000,
    processAlive: () => false,
    groupAlive: () => false,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usabl-lock-test-'));
  lockPath = join(dir, 'lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('demo integration lock', () => {
  it('acquires a free lock and records the owner', () => {
    expect(acquireLock(lockPath, deps())).toEqual({ state: 'acquired' });
    expect(readLockRecord(lockPath)).toEqual({ pid: 4242, startedAt: 1_000_000, nonce: 'nonce-a' });
  });

  it('refuses while the holder process is alive', () => {
    expect(acquireLock(lockPath, deps())).toEqual({ state: 'acquired' });
    const second = acquireLock(lockPath, deps({ pid: 5151, nonce: 'nonce-b', processAlive: (pid) => pid === 4242 }));
    expect(second.state).toBe('held');
    expect(second.state === 'held' && second.reason).toContain('pid 4242');
    expect(readLockRecord(lockPath)?.pid).toBe(4242);
  });

  it('treats an empty lock younger than the grace period as live', async () => {
    await writeFile(lockPath, '', 'utf8');
    const now = Date.now();
    const result = acquireLock(lockPath, deps({ now: () => now }));
    expect(result.state).toBe('held');
    expect(result.state === 'held' && result.reason).toContain('being initialised');
    expect(await readFile(lockPath, 'utf8')).toBe('');
  });

  it('reclaims an empty lock older than the grace period', async () => {
    await writeFile(lockPath, '', 'utf8');
    const old = (Date.now() - 2 * YOUNG_LOCK_MS) / 1000;
    await utimes(lockPath, old, old);
    expect(acquireLock(lockPath, deps({ now: Date.now }))).toEqual({ state: 'acquired' });
    expect(readLockRecord(lockPath)?.pid).toBe(4242);
  });

  it('reclaims a lock whose holder is dead and whose step group is gone', () => {
    expect(acquireLock(lockPath, deps({ pid: 1111, nonce: 'dead' }))).toEqual({ state: 'acquired' });
    expect(acquireLock(lockPath, deps())).toEqual({ state: 'acquired' });
    expect(readLockRecord(lockPath)?.pid).toBe(4242);
  });

  it('refuses while a dead holder\'s step group is still running', () => {
    const dead = deps({ pid: 1111, nonce: 'dead' });
    expect(acquireLock(lockPath, dead)).toEqual({ state: 'acquired' });
    updateLock(lockPath, dead, { stepPid: 9999 });
    const result = acquireLock(lockPath, deps({ groupAlive: (pgid) => pgid === 9999 }));
    expect(result.state).toBe('held');
    expect(result.state === 'held' && result.reason).toContain('process group 9999');
    expect(readLockRecord(lockPath)?.pid).toBe(1111);
  });

  it('does not remove a fresh lock created between the stale check and the reclaim', () => {
    expect(acquireLock(lockPath, deps({ pid: 1111, nonce: 'dead' }))).toEqual({ state: 'acquired' });
    const winner = deps({ pid: 2222, nonce: 'winner' });
    const loser = deps({
      pid: 3333,
      nonce: 'loser',
      processAlive: (pid) => pid === 2222,
      beforeReclaim: () => {
        // Another run reclaims the same stale lock first and now holds a live one.
        expect(acquireLock(lockPath, winner)).toEqual({ state: 'acquired' });
      },
    });
    const result = acquireLock(lockPath, loser);
    expect(result.state).toBe('held');
    expect(readLockRecord(lockPath)).toMatchObject({ pid: 2222, nonce: 'winner' });
  });

  it('releases only a lock it holds', () => {
    expect(acquireLock(lockPath, deps())).toEqual({ state: 'acquired' });
    releaseLock(lockPath, deps({ pid: 5151, nonce: 'other' }));
    expect(readLockRecord(lockPath)?.pid).toBe(4242);
    releaseLock(lockPath, deps());
    expect(readLockRecord(lockPath)).toBeNull();
  });

  it('records and clears the step group atomically in place', () => {
    const owner = deps();
    expect(acquireLock(lockPath, owner)).toEqual({ state: 'acquired' });
    updateLock(lockPath, owner, { stepPid: 777 });
    expect(readLockRecord(lockPath)).toMatchObject({ pid: 4242, stepPid: 777 });
    updateLock(lockPath, owner, {});
    expect(readLockRecord(lockPath)).toEqual({ pid: 4242, startedAt: 1_000_000, nonce: 'nonce-a' });
    expect(() => updateLock(lockPath, deps({ pid: 5151, nonce: 'other' }), { stepPid: 1 })).toThrow('no longer held');
  });
});
