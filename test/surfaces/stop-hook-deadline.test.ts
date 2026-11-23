/**
 * The Stop hook's own deadline. An assistant that ends a hook at its time limit lets the stop go
 * on, so an agent could stop without the accessibility work. The runner therefore ends inside the
 * host's limit: when its own deadline comes first, it stops the check, saves no receipt, and blocks
 * once with a plain message. On an active continuation it lets the stop through once with the same
 * notice. The deadline comes from an injected timer, so these tests never wait.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { mintReceipt } from '../../src/evidence/receipt.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { makeStopHookRunnerPorts, runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';
import {
  ANSWER_MARGIN_SECONDS,
  CLAUDE_DEFAULT_HOOK_TIMEOUT_SECONDS,
  CLAUDE_STOP_TIMEOUT_SECONDS,
  CURSOR_STOP_TIMEOUT_SECONDS,
  MIN_HOST_TIMEOUT_SECONDS,
  STOP_HOOK_TIMEOUT_ENV,
  hostLimit,
  runnerDeadlineSeconds,
} from '../../src/surfaces/stop-hook-deadline.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore, type MemoryPinStore } from '../support/memory-pin-store.js';

const RECEIPT_PATH = '.usabl/receipt.json';

class MemoryRunnerFs {
  private readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, contents);
  }

  async mkdir(_path: string): Promise<void> {}

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const configFixture: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const verifiedResult = (receipt: Result['receipt']): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
});

async function mintedReceipt(deps: Deps): Promise<NonNullable<Result['receipt']>> {
  return mintReceipt(deps, configFixture, {
    surfaces: ['cli'],
    checked: ['clusters'],
    notCovered: [],
    applicability: [],
    findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
    activeWaivers: 0,
  });
}

/**
 * A timer the test fires by hand. The first timer the runner starts is its deadline. Any later one
 * (the short wait for the browser to close) ends at once.
 */
function fakeDeadline(timeoutSetting: string | undefined, elapsedMs = 0) {
  const state = { requestedMs: [] as number[], cancelled: 0, ended: 0 };
  let fire: () => void = () => {
    throw new Error('the runner started no deadline timer');
  };
  const port = {
    timeoutSetting,
    elapsedMs: () => elapsedMs,
    startTimer: (ms: number) => {
      state.requestedMs.push(ms);
      let resolve: () => void = () => {};
      const expired = new Promise<void>((r) => {
        resolve = r;
      });
      if (state.requestedMs.length === 1) {
        fire = resolve;
      } else {
        resolve();
      }
      return {
        expired,
        cancel: () => {
          state.cancelled += 1;
        },
      };
    },
    endProcess: async () => {
      state.ended += 1;
    },
  };
  return { port, state, fire: () => fire() };
}

function harness(deadline: ReturnType<typeof fakeDeadline> | null) {
  const fs = new MemoryRunnerFs();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const browserClosed = { count: 0 };
  const base = makeFakeDeps();
  const deps: Deps = {
    ...base,
    browser: {
      ...base.browser,
      close: async () => {
        browserClosed.count += 1;
      },
    },
  };
  const ports = {
    fs,
    pins: memoryPinStore(),
    cwd: () => '/repo/deadline',
    stdoutWrite: async (text: string) => {
      stdout.push(text);
    },
    stderrWrite: async (text: string) => {
      stderr.push(text);
    },
    readConfigBytes: async () => committedConfigBytes(),
    loadConfig: async () => configFixture,
    buildDeps: async () => deps,
    runEngine: async (): Promise<Result> => verifiedResult(null),
    evaluateDecision: evaluateStopDecision,
    ...(deadline === null ? {} : { deadline: deadline.port }),
  };
  return { fs, stdout, stderr, ports, deps, browserClosed };
}

// Lets any work the runner left behind run, so a late write would show.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function stdoutObjects(stdout: string[]): Array<Record<string, unknown>> {
  return stdout
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the Stop hook deadline', () => {
  it('blocks once with the out-of-time message and saves no receipt when the deadline comes first', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    const receipt = await mintedReceipt(h.deps);
    // The run finishes just after the deadline with a verified result. Nothing it produced may
    // reach the output or the disk.
    h.ports.runEngine = async () => {
      deadline.fire();
      return verifiedResult(receipt);
    };

    expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-1' }), h.ports)).toBe(0);
    await settle();

    expect(deadline.state.requestedMs[0]).toBe((600 - 30) * 1000);
    const objects = stdoutObjects(h.stdout);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.['decision']).toBe('block');
    const reason = String(objects[0]?.['reason']);
    expect(reason.startsWith('NOT verified - usabl ran out of time')).toBe(true);
    expect(reason).toContain('570 seconds');
    expect(reason).toContain('600 seconds');
    expect(reason).toContain('Nothing is proven about this change, and no receipt was saved.');
    expect(reason).toContain('narrow the change');
    expect(reason).toContain('run usabl check by hand');
    expect(reason).toContain('raise the limit in the hook settings');
    expect(reason).toContain('.claude/settings.json');
    expect(reason).not.toContain('let this stop through');
    expect(h.fs.writes).not.toContain(RECEIPT_PATH);
    expect(await h.fs.readFile(RECEIPT_PATH)).toBeNull();
    expect(h.stderr.join('')).not.toContain('VERIFIED');
    // The scan is stopped and the process ends, so the assistant gets the answer in time.
    expect(h.browserClosed.count).toBeGreaterThanOrEqual(1);
    expect(deadline.state.ended).toBe(1);
  });

  it('lets an active continuation through once with the same notice', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    h.ports.runEngine = async () => {
      deadline.fire();
      return verifiedResult(await mintedReceipt(h.deps));
    };

    const input = JSON.stringify({ session_id: 'deadline-2', stop_hook_active: true });
    expect(await runStopHookFromStdin(input, h.ports)).toBe(0);
    await settle();

    const objects = stdoutObjects(h.stdout);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.['decision']).toBeUndefined();
    const message = String(objects[0]?.['systemMessage']);
    expect(message.startsWith('NOT verified - usabl ran out of time')).toBe(true);
    expect(message).toContain('usabl let this stop through without blocking again (continuation already active).');
    expect(message).toContain('Nothing is proven about this change, and no receipt was saved.');
    expect(h.stderr.join('')).toContain('NOT verified - usabl ran out of time');
    expect(await h.fs.readFile(RECEIPT_PATH)).toBeNull();
    expect(deadline.state.ended).toBe(1);
  });

  it('leaves a stop that ends under the deadline as it was', async () => {
    const withDeadline = fakeDeadline('600');
    const timed = harness(withDeadline);
    const plain = harness(null);
    const receipt = await mintedReceipt(timed.deps);
    timed.ports.runEngine = async () => verifiedResult(receipt);
    plain.ports.runEngine = async () => verifiedResult(receipt);
    const input = JSON.stringify({ session_id: 'deadline-3' });

    expect(await runStopHookFromStdin(input, timed.ports)).toBe(0);
    expect(await runStopHookFromStdin(input, plain.ports)).toBe(0);
    await settle();

    expect(timed.stdout).toEqual(plain.stdout);
    expect(timed.stderr).toEqual(plain.stderr);
    expect(await timed.fs.readFile(RECEIPT_PATH)).not.toBeNull();
    expect(withDeadline.state.cancelled).toBeGreaterThanOrEqual(1);
    expect(withDeadline.state.ended).toBe(0);
  });

  it('answers in the Cursor protocol and plans to the Cursor limit when the hook sets none', async () => {
    const deadline = fakeDeadline(undefined);
    const h = harness(deadline);
    h.ports.runEngine = async () => {
      deadline.fire();
      return verifiedResult(null);
    };

    expect(await runStopHookFromStdin(JSON.stringify({ loop_count: 0 }), h.ports, { cursorMode: true })).toBe(0);
    await settle();

    expect(deadline.state.requestedMs[0]).toBe((300 - 30) * 1000);
    const objects = stdoutObjects(h.stdout);
    expect(objects).toHaveLength(1);
    const followup = String(objects[0]?.['followup_message']);
    expect(followup.startsWith('NOT verified - usabl ran out of time')).toBe(true);
    expect(followup).toContain('.cursor/hooks.json');
    // To raise the limit, the reinstall makes the adapter script pass the new timeout. The
    // environment Cursor runs in is never the place to set it.
    expect(followup).not.toContain('where Cursor runs the hook');
    expect(followup).toContain('run usabl install --cursor again');
  });

  it("plans to Claude Code's default of 600 seconds when the hook command sets no limit, and says to reinstall", async () => {
    const deadline = fakeDeadline(undefined);
    const h = harness(deadline);
    h.ports.runEngine = async () => {
      deadline.fire();
      return verifiedResult(null);
    };

    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    await settle();

    expect(deadline.state.requestedMs[0]).toBe((600 - 30) * 1000);
    const reason = String(stdoutObjects(h.stdout)[0]?.['reason']);
    expect(reason).toContain('570 seconds');
    expect(reason).toContain("Claude Code's default");
    expect(reason).toContain(STOP_HOOK_TIMEOUT_ENV);
    expect(reason).toContain('Run usabl install --claude again so the hook states its time limit.');
  });

  it('does not name the reinstall step when the hook command sets a limit, or in Cursor mode', async () => {
    for (const [setting, cursorMode] of [
      ['600', false],
      [undefined, true],
    ] as const) {
      const deadline = fakeDeadline(setting);
      const h = harness(deadline);
      h.ports.runEngine = async () => {
        deadline.fire();
        return verifiedResult(null);
      };
      expect(await runStopHookFromStdin('{}', h.ports, { cursorMode })).toBe(0);
      await settle();
      const answer = stdoutObjects(h.stdout)[0] ?? {};
      const text = String(answer['reason'] ?? answer['followup_message']);
      expect(text.startsWith('NOT verified - usabl ran out of time')).toBe(true);
      expect(text).not.toContain('install --claude again');
    }
  });

  it('keeps a limit the hook command sets, and the half-limit rule below 60 seconds', async () => {
    for (const [setting, expectedMs] of [
      ['900', 870_000],
      ['120', 90_000],
      ['45', 22_000],
    ] as const) {
      const deadline = fakeDeadline(setting);
      expect(await runStopHookFromStdin('{}', harness(deadline).ports)).toBe(0);
      expect(deadline.state.requestedMs[0]).toBe(expectedMs);
    }
  });

  it('counts the time the hook process already ran before the runner started', async () => {
    const deadline = fakeDeadline('600', 4_000);
    const h = harness(deadline);
    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    expect(deadline.state.requestedMs[0]).toBe(570_000 - 4_000);
  });

  it('reads the limit the hook command sets from the environment', () => {
    const ports = makeStopHookRunnerPorts({ env: { [STOP_HOOK_TIMEOUT_ENV]: '900' }, startDir: '/', deadline: true });
    expect(ports.deadline?.timeoutSetting).toBe('900');
    // The deadline counts from the start of the process, so only the stop-hook command turns it
    // on. Ports a test builds inside a long-lived test worker leave it off.
    expect(makeStopHookRunnerPorts({ env: {}, startDir: '/' }).deadline).toBeUndefined();
  });
});

describe('the Stop hook deadline and an answer already being written', () => {
  it('keeps the receipt and the answer of a check that was saving its receipt when the deadline came', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    const receipt = await mintedReceipt(h.deps);
    h.ports.runEngine = async () => verifiedResult(receipt);
    // The deadline comes while the receipt is being written. The write lands, so the stop must not
    // then say that no receipt was saved.
    const write = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = async (path: string, contents: string) => {
      if (path === RECEIPT_PATH) {
        deadline.fire();
      }
      await write(path, contents);
    };

    expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-4' }), h.ports)).toBe(0);
    await settle();

    expect(await h.fs.readFile(RECEIPT_PATH)).not.toBeNull();
    expect(h.stderr.join('')).toContain('VERIFIED');
    expect(h.stderr.join('')).not.toContain('ran out of time');
    expect(h.stdout.join('')).not.toContain('ran out of time');
  });

  it('writes one answer when the deadline comes while the check is writing its own block', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    h.ports.evaluateDecision = () => ({ block: true, message: 'NOT verified - a check block.' });
    const stdoutWrite = h.ports.stdoutWrite;
    h.ports.stdoutWrite = async (text: string) => {
      deadline.fire();
      await stdoutWrite(text);
    };

    expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-5' }), h.ports)).toBe(0);
    await settle();

    const objects = stdoutObjects(h.stdout);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toEqual({ decision: 'block', reason: 'NOT verified - a check block.' });
  });

  it('ends the process in time when the check started its answer and never finished it', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    h.ports.evaluateDecision = () => ({ block: true, message: 'NOT verified - a check block.' });
    const stdoutWrite = h.ports.stdoutWrite;
    h.ports.stdoutWrite = async (text: string) => {
      await stdoutWrite(text);
      deadline.fire();
      // The rest of the answer never gets written.
      await new Promise<void>(() => {});
    };

    expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-6' }), h.ports)).toBe(0);
    await settle();

    expect(stdoutObjects(h.stdout)).toHaveLength(1);
    expect(deadline.state.ended).toBe(1);
    expect(h.browserClosed.count).toBeGreaterThanOrEqual(1);
  });

  it('ends the process before the host limit when the browser does not close after the answer', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    h.ports.runEngine = async () => verifiedResult(await mintedReceipt(h.deps));
    h.deps.browser.close = () => new Promise<void>(() => {});

    const run = runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-7' }), h.ports);
    await settle();
    expect(h.stderr.join('')).toContain('VERIFIED');
    expect(deadline.state.ended).toBe(0);

    // The deadline comes while the browser is still closing. The answer is written, so the
    // process ends and the host reads it.
    deadline.fire();
    await settle();
    expect(deadline.state.ended).toBe(1);
    expect(await run).toBe(0);
    expect(h.stdout.join('')).not.toContain('ran out of time');
  });

  it('stops the deadline timer and closes the browser when the check fails outright', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    h.ports.stderrWrite = async () => {
      throw new Error('stderr is closed');
    };

    await expect(runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-8' }), h.ports)).rejects.toThrow('stderr is closed');

    expect(deadline.state.cancelled).toBe(1);
    expect(h.browserClosed.count).toBe(1);
  });
});

describe('the Stop hook deadline and the session pins', () => {
  it('writes no pin after the deadline, neither the first pins nor a replacement', async () => {
    // A stop under the deadline records the first pins for the session.
    const first = harness(fakeDeadline('600'));
    expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-pins' }), first.ports)).toBe(0);
    const firstPins = first.ports.pins as MemoryPinStore;
    expect(firstPins.writes).toHaveLength(1);

    for (const seeded of [false, true]) {
      const deadline = fakeDeadline('600');
      const h = harness(deadline);
      const pins = h.ports.pins as MemoryPinStore;
      if (seeded) {
        for (const [name, contents] of firstPins.files) {
          pins.files.set(name, contents);
        }
      }
      // The deadline comes before the pins are compared and written.
      h.ports.buildDeps = async () => {
        deadline.fire();
        await settle();
        return h.deps;
      };
      expect(await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-pins' }), h.ports)).toBe(0);
      await settle();

      expect(pins.writes).toEqual([]);
      expect(String(stdoutObjects(h.stdout)[0]?.['reason'])).toContain('usabl ran out of time');
    }
  });
});

describe('the waits after the deadline fit the time left', () => {
  function engineFiresDeadline(deadline: ReturnType<typeof fakeDeadline>, h: ReturnType<typeof harness>): void {
    h.ports.runEngine = async () => {
      deadline.fire();
      return verifiedResult(null);
    };
  }

  it('keeps each wait at 10 seconds when the limit leaves the full 30 second margin', async () => {
    const deadline = fakeDeadline('600');
    const h = harness(deadline);
    engineFiresDeadline(deadline, h);
    await runStopHookFromStdin('{}', h.ports);
    expect(deadline.state.requestedMs).toEqual([570_000, 10_000]);
  });

  it('shrinks the browser close wait to a third of the margin for a short limit', async () => {
    // A 40 second limit has a 20 second deadline and 20 seconds left, so the wait is 6.666 seconds.
    const deadline = fakeDeadline('40');
    const h = harness(deadline);
    engineFiresDeadline(deadline, h);
    await runStopHookFromStdin('{}', h.ports);
    expect(deadline.state.requestedMs).toEqual([20_000, 6_666]);
  });

  it('shrinks both waits when the check was already answering', async () => {
    const deadline = fakeDeadline('40');
    const h = harness(deadline);
    h.ports.evaluateDecision = () => ({ block: true, message: 'NOT verified - a check block.' });
    const stdoutWrite = h.ports.stdoutWrite;
    h.ports.stdoutWrite = async (text: string) => {
      await stdoutWrite(text);
      deadline.fire();
      await new Promise<void>(() => {});
    };
    await runStopHookFromStdin(JSON.stringify({ session_id: 'deadline-waits' }), h.ports);
    expect(deadline.state.requestedMs).toEqual([20_000, 6_666, 6_666]);
    expect(deadline.state.ended).toBe(1);
  });
});

describe('a USABL_STOP_HOOK_TIMEOUT value usabl cannot use', () => {
  for (const value of ['0600', '6.5', '-1']) {
    it(`says ${JSON.stringify(value)} was set and ignored, not that the hook sets none`, async () => {
      const deadline = fakeDeadline(value);
      const h = harness(deadline);
      h.ports.runEngine = async () => {
        deadline.fire();
        return verifiedResult(null);
      };
      expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
      await settle();

      expect(deadline.state.requestedMs[0]).toBe(570_000);
      const reason = String(stdoutObjects(h.stdout)[0]?.['reason']);
      expect(reason).toContain(`${STOP_HOOK_TIMEOUT_ENV} was set to a value that is not a whole number of seconds`);
      expect(reason).toContain('so usabl ignored it');
      expect(reason).not.toContain(`sets no ${STOP_HOOK_TIMEOUT_ENV}`);
      // The value itself is never printed.
      expect(reason).not.toContain(` ${value} `);
    });
  }
});

describe('the host limit and the runner deadline', () => {
  it('states the numbers', () => {
    expect(CLAUDE_STOP_TIMEOUT_SECONDS).toBe(600);
    expect(CURSOR_STOP_TIMEOUT_SECONDS).toBe(300);
    expect(CLAUDE_DEFAULT_HOOK_TIMEOUT_SECONDS).toBe(600);
    expect(ANSWER_MARGIN_SECONDS).toBe(30);
    expect(MIN_HOST_TIMEOUT_SECONDS).toBe(60);
  });

  it('takes the limit the hook sets, or the host default when it sets none or an unusable value', () => {
    expect(hostLimit('600', false)).toEqual({ seconds: 600, source: 'hook', ignored: false });
    expect(hostLimit(' 1200 ', true)).toEqual({ seconds: 1200, source: 'hook', ignored: false });
    expect(hostLimit(undefined, false)).toEqual({ seconds: 600, source: 'claude-default', ignored: false });
    expect(hostLimit(undefined, true)).toEqual({ seconds: 300, source: 'cursor-install', ignored: false });
    for (const bad of ['', 'abc', '0', '-5', '1.5', '1e3', '9999999', '0600']) {
      expect(hostLimit(bad, false)).toEqual({ seconds: 600, source: 'claude-default', ignored: true });
      expect(hostLimit(bad, true)).toEqual({ seconds: 300, source: 'cursor-install', ignored: true });
    }
  });

  it('leaves 30 seconds to answer, and half the limit below the minimum', () => {
    expect(runnerDeadlineSeconds(600)).toBe(570);
    expect(runnerDeadlineSeconds(300)).toBe(270);
    expect(runnerDeadlineSeconds(60)).toBe(30);
    expect(runnerDeadlineSeconds(45)).toBe(22);
    expect(runnerDeadlineSeconds(1)).toBe(1);
  });
});
