/**
 * Claude Code does not show the stderr of a Stop hook that exits 0, and it sends the plain stdout
 * of a Stop hook to its debug log. So an allow that carries a notice also writes one JSON object
 * to stdout with a systemMessage field, which Claude Code shows to the person. Each case here is
 * one kind of notice: stdout is one valid JSON object with that field, the field holds the same
 * text stderr gets, and the exit code stays 0. A verified allow with no notice writes nothing to
 * stdout, as before, a block is sent as before, and Cursor still gets {}.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt, Result } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { BYPASS_ONCE_PATH, ReceiptWriteRefused } from '../../src/surfaces/receipt-store.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import {
  runStopHookFromStdin,
  sessionPinFileName,
  type ConfigBytes,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import type { SessionPinStore } from '../../src/surfaces/session-pin-store.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const CONFIG = JSON.stringify({
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
});
const ROOT = '/repo/one';
const SESSION = 'session-one';

function result(overrides: Partial<Result> = {}): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'verified: 0 gating finding(s)',
    screens: [],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [],
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: null,
    accessibilityExitCode: 0,
    paidDownCount: 0,
    floorHeadroom: [],
    floorUnconfirmed: [],
    ...overrides,
  };
}

interface HarnessOptions {
  bytes?: ConfigBytes;
  engine?: Result;
  pins?: SessionPinStore;
  files?: Record<string, string>;
  receiptWrite?: () => Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const deps = makeFakeDeps({ files: { 'usabl.config.json': CONFIG }, headContents: { 'usabl.config.json': CONFIG } });
  const ports: StopHookRunnerPorts = {
    fs: {
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, contents) => {
        if (options.receiptWrite !== undefined) {
          await options.receiptWrite();
        }
        files.set(path, contents);
      },
      mkdir: async () => {},
      unlink: async (path) => {
        files.delete(path);
      },
    },
    pins: options.pins ?? memoryPinStore(),
    cwd: () => ROOT,
    stdoutWrite: async (text) => {
      stdout.push(text);
    },
    stderrWrite: async (text) => {
      stderr.push(text);
    },
    readConfigBytes: async () => options.bytes ?? committedConfigBytes(CONFIG),
    loadConfig: async (text) => JSON.parse(text),
    buildDeps: async () => deps,
    runEngine: async () => options.engine ?? result(),
    evaluateDecision: evaluateStopDecision,
  };
  return { ports, stdout: () => stdout.join(''), stderr: () => stderr.join('') };
}

function input(active: boolean, sessionId: string | null = SESSION): string {
  return JSON.stringify({ stop_hook_active: active, ...(sessionId === null ? {} : { session_id: sessionId }) });
}

/** stdout must be exactly one JSON object with a systemMessage string, and nothing else. */
function systemMessage(stdout: string): string {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  const payload = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  expect(Object.keys(payload)).toEqual(['systemMessage']);
  expect(typeof payload['systemMessage']).toBe('string');
  return payload['systemMessage'] as string;
}

async function stop(h: ReturnType<typeof harness>, stdin: string): Promise<string> {
  expect(await runStopHookFromStdin(stdin, h.ports)).toBe(0);
  const message = systemMessage(h.stdout());
  // The field holds the text stderr gets, line for line.
  expect(`${message}\n`).toBe(h.stderr());
  return message;
}

describe('Claude Stop hook allows that carry a notice write a systemMessage the person sees', () => {
  it('the bypass notice', async () => {
    const h = harness({ files: { [BYPASS_ONCE_PATH]: 'now' } });
    expect(await stop(h, input(false))).toContain('NOT verified - BYPASS consumed');
  });

  it('the not-configured note', async () => {
    const h = harness({ bytes: { working: { status: 'missing' }, head: { status: 'missing' } } });
    expect(await stop(h, input(false))).toContain('usabl is not configured here');
  });

  it('the note for a folder outside any work tree, with the folder inside the frame', async () => {
    const h = harness({ bytes: { working: { status: 'missing' }, head: { status: 'no-work-tree' } } });
    const message = await stop(h, input(false));
    expect(message).toContain('outside any git work tree');
    expect(message.indexOf(`folder: ${ROOT}`)).toBeGreaterThan(message.indexOf('[BEGIN UNTRUSTED TEXT'));
  });

  it('a config continuation that is let through', async () => {
    const h = harness({ bytes: { working: { status: 'found', text: '{}' }, head: { status: 'found', text: CONFIG } } });
    const message = await stop(h, input(true));
    expect(message).toContain('approval required');
    expect(message).toContain('continuation already active');
  });

  it('a drift continuation that is let through', async () => {
    const pins = memoryPinStore();
    pins.files.set(sessionPinFileName(SESSION, ROOT), JSON.stringify({ 'usabl.config.json': 'an older digest' }));
    const h = harness({ pins });
    const message = await stop(h, input(true));
    expect(message).toContain('guarded policy drift during this session');
    expect(message).toContain('continuation already active');
  });

  it('a stop hook error, with the error inside the frame', async () => {
    const h = harness({ bytes: { working: { status: 'found', text: CONFIG }, head: { status: 'unreadable', reason: 'git exploded' } } });
    const message = await stop(h, input(false));
    expect(message).toContain('NOT verified - stop hook error');
    expect(message.indexOf('git exploded')).toBeGreaterThan(message.indexOf('[BEGIN UNTRUSTED TEXT'));
  });

  it('a run that failed with no verdict', async () => {
    const h = harness({ engine: result({ verdict: null, exitCode: 4, summary: 'engine crashed' }) });
    expect(await stop(h, input(false))).toContain('NO VERDICT: RUN FAILED (exit 4)');
  });

  it('a run with nothing to check', async () => {
    const h = harness({
      engine: result({
        verdict: null,
        summary: 'nothing to check',
        coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
      }),
    });
    expect(await stop(h, input(false))).toContain('NO VERDICT: IDLE');
  });

  it('a blocking verdict let through because continuation is active', async () => {
    const h = harness({ engine: result({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }) });
    const message = await stop(h, input(true));
    expect(message).toContain('NOT verified. usabl let this stop through without blocking again');
  });

  it('the pin notice when the hook input carried no session id, after the verified line', async () => {
    const h = harness();
    const message = await stop(h, input(false, null));
    expect(message).toContain('VERIFIED (exit 0, session drift not checked)');
    expect(message).toContain('NOT verified - usabl did not use session pins for this stop');
  });

  it('the pin notice when the pin store refused, with its reason inside the frame', async () => {
    const pins = memoryPinStore();
    pins.read = async () => ({ status: 'refused', reason: 'the pin folder /tmp/x is not private', fix: 'remove /tmp/x.' });
    const h = harness({ pins });
    const message = await stop(h, input(false));
    expect(message).toContain('the pin store refused to read them');
    expect(message.indexOf('/tmp/x')).toBeGreaterThan(message.indexOf('[BEGIN UNTRUSTED TEXT'));
  });

  it('the receipt-not-saved notice, after the verified line', async () => {
    const h = harness({
      engine: result({ receipt: { sourceTree: 'tree-one' } as unknown as Receipt }),
      receiptWrite: async () => {
        throw new ReceiptWriteRefused('.usabl/receipt.json', 'is a symbolic link');
      },
    });
    const message = await stop(h, input(false));
    expect(message.startsWith('VERIFIED (exit 0)')).toBe(true);
    expect(message).toContain('NOT saved - usabl did not save the receipt');
  });

  it('the invalid input message', async () => {
    const h = harness();
    expect(await stop(h, '{not json')).toContain('NOT verified');
  });
});

describe('Claude Stop hook output that does not change', () => {
  it('a verified allow with no notice writes nothing to stdout', async () => {
    const h = harness();
    expect(await runStopHookFromStdin(input(false), h.ports)).toBe(0);
    expect(h.stdout()).toBe('');
    expect(h.stderr()).toContain('VERIFIED (exit 0)');
  });

  it('a block is one decision object, with no systemMessage', async () => {
    const h = harness({ engine: result({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }) });
    expect(await runStopHookFromStdin(input(false, null), h.ports)).toBe(0);
    const lines = h.stdout().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['decision', 'reason']);
    expect(payload['decision']).toBe('block');
    // The pin notice still follows the block on stderr.
    expect(h.stderr()).toContain('NOT verified - usabl did not use session pins for this stop');
  });

  it('Cursor still gets {} on an allow that carries a notice', async () => {
    const h = harness({ bytes: { working: { status: 'missing' }, head: { status: 'missing' } } });
    expect(await runStopHookFromStdin('{}', h.ports, { cursorMode: true })).toBe(0);
    expect(h.stdout()).toBe('{}\n');
    expect(h.stderr()).toContain('usabl is not configured here');
  });

  it('Cursor still gets {} for input it could not read', async () => {
    const h = harness();
    expect(await runStopHookFromStdin('{not json', h.ports, { cursorMode: true })).toBe(0);
    expect(h.stdout()).toBe('{}\n');
  });
});
