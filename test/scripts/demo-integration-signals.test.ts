import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { exitFallback, ownSignals, type ExitFallbackDeps } from '../../scripts/demo-integration-signals.js';

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

describe('ownSignals', () => {
  it('takes over listeners other modules installed and becomes the only one', () => {
    const host = new EventEmitter();
    const hostExit = vi.fn();
    const other = vi.fn();
    host.once('SIGTERM', hostExit);
    host.on('SIGINT', other);
    const handler = vi.fn();

    const claimed = ownSignals(host, SIGNALS, handler);
    expect(claimed.captured).toBe(2);

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

    expect(ownSignals(host, SIGNALS, vi.fn()).captured).toBe(0);

    host.emit('exit', 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('replays the captured listeners only when asked, after the step is stopped, in order and with the signal arguments', async () => {
    const host = new EventEmitter();
    const events: string[] = [];
    const first = vi.fn(function (this: unknown, ...args: unknown[]) {
      events.push(`first:${args.join(',')}:${this === host ? 'host' : 'other'}`);
    });
    const second = vi.fn(async (...args: unknown[]) => {
      events.push(`second:${args.join(',')}`);
    });
    host.once('SIGTERM', first);
    host.on('SIGTERM', second);
    const claimed = ownSignals(host, SIGNALS, (signal, ...rest) => {
      events.push(`handler:${signal}:${rest.join(',')}`);
    });

    host.emit('SIGTERM', 'SIGTERM', 15);
    expect(events).toEqual(['handler:SIGTERM:15']);

    events.push('step stopped');
    await claimed.replay('SIGTERM', [15], 1_000);
    expect(events).toEqual(['handler:SIGTERM:15', 'step stopped', 'first:SIGTERM,15:host', 'second:SIGTERM,15']);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('bounds the wait for a replayed listener that never settles', async () => {
    const host = new EventEmitter();
    host.on('SIGTERM', () => new Promise<void>(() => {}));
    const claimed = ownSignals(host, SIGNALS, vi.fn());

    const started = Date.now();
    await claimed.replay('SIGTERM', [15], 50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('replays nothing for a signal that had no listeners', async () => {
    const claimed = ownSignals(new EventEmitter(), SIGNALS, vi.fn());
    await expect(claimed.replay('SIGHUP', [1], 50)).resolves.toBeUndefined();
  });
});

describe('exitFallback', () => {
  function deps(overrides: Partial<ExitFallbackDeps> = {}) {
    const base = {
      code: 0,
      stepPgid: null,
      shutdownExitCode: null,
      host: { exitCode: 0 } as { exitCode?: number | string | null | undefined },
      groupAlive: vi.fn(() => false),
      killGroup: vi.fn(),
      releaseLock: vi.fn(),
      warn: vi.fn(),
    } satisfies ExitFallbackDeps;
    return { ...base, ...overrides };
  }

  it('kills a step group that is still running, leaves the lock, and turns exit 0 into a failure', () => {
    const d = deps({ stepPgid: 777, groupAlive: vi.fn((pgid) => pgid === 777) });
    expect(exitFallback(d)).toBe('interrupted');
    expect(d.killGroup).toHaveBeenCalledWith(777);
    expect(d.releaseLock).not.toHaveBeenCalled();
    expect(d.host.exitCode).toBe(1);
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('run interrupted'));
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('process group 777'));
  });

  it('releases the lock when the recorded step group has already ended, and still fails the run', () => {
    const d = deps({ stepPgid: 777, code: 0 });
    expect(exitFallback(d)).toBe('interrupted');
    expect(d.killGroup).not.toHaveBeenCalled();
    expect(d.releaseLock).toHaveBeenCalledTimes(1);
    expect(d.host.exitCode).toBe(1);
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('run interrupted'));
  });

  it('keeps the shutdown exit code when a replayed listener exits with another one', () => {
    const d = deps({ code: 143, shutdownExitCode: 130, host: { exitCode: 143 } });
    expect(exitFallback(d)).toBe('shutdown');
    expect(d.host.exitCode).toBe(130);
    expect(d.releaseLock).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('releases the lock and leaves the exit code alone when no step is running', () => {
    const d = deps({ code: 0 });
    expect(exitFallback(d)).toBe('released');
    expect(d.groupAlive).not.toHaveBeenCalled();
    expect(d.releaseLock).toHaveBeenCalledTimes(1);
    expect(d.host.exitCode).toBe(0);
  });
});
