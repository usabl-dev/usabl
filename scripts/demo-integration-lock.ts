/**
 * Exclusive lock for the demo integration runner.
 *
 * One JSON file in the engine checkout. Creation is atomic (`wx`) and the record
 * is written before anything else, so a reader that sees an empty file has caught
 * another run between those two calls. Such a file is treated as live while it is
 * younger than YOUNG_LOCK_MS; older it counts as left by a dead writer.
 *
 * A lock is stale when its holder pid is dead and no step group it recorded is
 * still running. Reclaiming a stale lock moves the file aside with a rename, then
 * compares what was moved with what was judged stale. A mismatch means another run
 * created a fresh lock in between; that file is moved back. After a correct
 * reclaim the caller retries `wx`, and a failure there means someone else won.
 *
 * Known limit: if a third run creates a lock during the moving-back step, the
 * rename replaces it and two runs believe they hold the lock. Closing that window
 * needs a kernel lock primitive, which this tooling deliberately avoids.
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';

export const YOUNG_LOCK_MS = 5_000;
const MAX_ATTEMPTS = 3;

export interface LockRecord {
  pid: number;
  startedAt: number;
  nonce: string;
  stepPid?: number;
}

export interface LockDeps {
  pid: number;
  nonce: string;
  now: () => number;
  processAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
  /** Test seam: runs after a lock is judged stale and before it is moved aside. */
  beforeReclaim?: () => void;
}

export type AcquireResult =
  | { state: 'acquired' }
  | { state: 'held'; reason: string };

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const pid = Reflect.get(parsed, 'pid');
    const startedAt = Reflect.get(parsed, 'startedAt');
    const nonce = Reflect.get(parsed, 'nonce');
    const stepPid = Reflect.get(parsed, 'stepPid');
    if (typeof pid !== 'number' || typeof startedAt !== 'number' || typeof nonce !== 'string') {
      return null;
    }
    return { pid, startedAt, nonce, ...(typeof stepPid === 'number' ? { stepPid } : {}) };
  } catch {
    return null;
  }
}

export function readLockRecord(lockPath: string): LockRecord | null {
  const raw = readRaw(lockPath);
  return raw === null ? null : parseLockRecord(raw);
}

function ownRecord(deps: LockDeps): LockRecord {
  return { pid: deps.pid, startedAt: deps.now(), nonce: deps.nonce };
}

function tryCreate(lockPath: string, deps: LockDeps): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(ownRecord(deps)));
  } finally {
    closeSync(fd);
  }
  return true;
}

type Judgement = { state: 'live'; reason: string } | { state: 'stale'; raw: string };

function judge(lockPath: string, deps: LockDeps): Judgement | null {
  const raw = readRaw(lockPath);
  if (raw === null) {
    return null;
  }
  const record = parseLockRecord(raw);
  if (record === null) {
    let ageMs: number;
    try {
      ageMs = deps.now() - statSync(lockPath).mtimeMs;
    } catch {
      return null;
    }
    if (ageMs < YOUNG_LOCK_MS) {
      return { state: 'live', reason: `${lockPath} is being initialised by another run` };
    }
    return { state: 'stale', raw };
  }
  if (deps.processAlive(record.pid)) {
    return { state: 'live', reason: `another demo integration run (pid ${record.pid}) holds ${lockPath}` };
  }
  if (record.stepPid !== undefined && deps.groupAlive(record.stepPid)) {
    return {
      state: 'live',
      reason: `the run that held ${lockPath} (pid ${record.pid}) is gone but its build or test process group ${record.stepPid} is still running`,
    };
  }
  return { state: 'stale', raw };
}

/** Moves a stale lock aside. Returns false when the file at the path was no longer the stale one. */
function reclaim(lockPath: string, staleRaw: string, deps: LockDeps): boolean {
  deps.beforeReclaim?.();
  const aside = `${lockPath}.reclaim-${deps.pid}-${deps.nonce}`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  const moved = readRaw(aside);
  if (moved === staleRaw) {
    rmSync(aside, { force: true });
    return true;
  }
  // Another run replaced the stale lock before our rename. Give theirs back.
  renameSync(aside, lockPath);
  return false;
}

export function acquireLock(lockPath: string, deps: LockDeps): AcquireResult {
  let lastReason = `${lockPath} stayed contended`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (tryCreate(lockPath, deps)) {
      return { state: 'acquired' };
    }
    const judgement = judge(lockPath, deps);
    if (judgement === null) {
      // Removed between our attempt and our read. Try again.
      continue;
    }
    if (judgement.state === 'live') {
      return { state: 'held', reason: judgement.reason };
    }
    if (!reclaim(lockPath, judgement.raw, deps)) {
      lastReason = `${lockPath} was taken by another run while this one was reclaiming it`;
      return { state: 'held', reason: lastReason };
    }
  }
  return { state: 'held', reason: lastReason };
}

/** Rewrites the held lock atomically with the running step's group id. */
export function updateLock(lockPath: string, deps: LockDeps, patch: { stepPid?: number }): void {
  const current = readLockRecord(lockPath);
  if (current === null || current.pid !== deps.pid || current.nonce !== deps.nonce) {
    throw new Error(`${lockPath} is no longer held by this run`);
  }
  const next: LockRecord = { pid: current.pid, startedAt: current.startedAt, nonce: current.nonce };
  if (patch.stepPid !== undefined) {
    next.stepPid = patch.stepPid;
  }
  const temp = `${lockPath}.update-${deps.pid}-${deps.nonce}`;
  writeFileSync(temp, JSON.stringify(next), 'utf8');
  renameSync(temp, lockPath);
}

/** Removes the lock only when this run still holds it. */
export function releaseLock(lockPath: string, deps: LockDeps): void {
  const current = readLockRecord(lockPath);
  if (current !== null && current.pid === deps.pid && current.nonce === deps.nonce) {
    rmSync(lockPath, { force: true });
  }
}
