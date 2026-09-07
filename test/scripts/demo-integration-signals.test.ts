import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { exitFallback, ownSignals, type ExitFallbackDeps } from '../../scripts/demo-integration-signals.js';

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

describe('ownSignals', () => {
  it('removes listeners other modules installed and becomes the only one', () => {
    const host = new EventEmitter();
    const hostExit = vi.fn();
    const other = vi.fn();
    host.once('SIGTERM', hostExit);
    host.on('SIGINT', other);
    const handler = vi.fn();

    expect(ownSignals(host, SIGNALS, handler)).toBe(2);

    host.emit('SIGTERM', 'SIGTERM', 15);
    host.emit('SIGINT', 'SIGINT', 2);
    host.emit('SIGHUP', 'SIGHUP', 1);
    expect(hostExit).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(handler.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
    for (const signal of SIGNALS) {
      expect(host.listenerCount(signal)).toBe(1);
    }
  });

  it('leaves listeners for other events alone', () => {
    const host = new EventEmitter();
    const onExit = vi.fn();
    host.on('exit', onExit);

    expect(ownSignals(host, SIGNALS, vi.fn())).toBe(0);

    host.emit('exit', 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe('exitFallback', () => {
  function deps(overrides: Partial<ExitFallbackDeps> = {}) {
    const base = {
      stepPgid: null,
      groupAlive: vi.fn(() => false),
      killGroup: vi.fn(),
      releaseLock: vi.fn(),
      warn: vi.fn(),
    } satisfies ExitFallbackDeps;
    return { ...base, ...overrides };
  }

  it('kills a step group that is still running and leaves the lock', () => {
    const d = deps({ stepPgid: 777, groupAlive: vi.fn((pgid) => pgid === 777) });
    expect(exitFallback(d)).toBe('left');
    expect(d.killGroup).toHaveBeenCalledWith(777);
    expect(d.releaseLock).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('process group 777'));
  });

  it('releases the lock when the recorded step group has already ended', () => {
    const d = deps({ stepPgid: 777 });
    expect(exitFallback(d)).toBe('released');
    expect(d.killGroup).not.toHaveBeenCalled();
    expect(d.releaseLock).toHaveBeenCalledTimes(1);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('releases the lock when no step is running', () => {
    const d = deps();
    expect(exitFallback(d)).toBe('released');
    expect(d.groupAlive).not.toHaveBeenCalled();
    expect(d.releaseLock).toHaveBeenCalledTimes(1);
  });
});
