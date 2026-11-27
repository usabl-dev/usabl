/**
 * A stop that refused to read a path because it is not a regular file blocks once, naming the
 * path, and saves no receipt. Whatever the checks found, they did not read everything they check:
 * a named pipe at a source file, the config, or the bypass file is never read, because a plain read
 * of a pipe waits for a writer and keeps the process from exiting. The continuation is let through
 * with the same paths named, never with the allow's own words, so it never reads as VERIFIED.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt, Result } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { NotRegularFileError } from '../../src/deps/regular-file.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin, type StopHookRunnerPorts } from '../../src/surfaces/stop-hook-runner.js';
import { testConfig } from '../helpers.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const config = testConfig({});
const configBytes = '{}';
const files = { 'usabl.config.json': configBytes };

const verified: Result = {
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: { sourceTree: 'tree' } as unknown as Receipt,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
};

interface Stop {
  stdout: string;
  stderr: string;
  written: string[];
}

/** A stop whose bypass file is a pipe, recorded as the real readers record it. */
async function stop(options: { continuation: boolean; withRefusals: boolean }): Promise<Stop> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: string[] = [];
  const refusals = new Set<string>();
  const ports: StopHookRunnerPorts = {
    fs: {
      readFile: async (path) => {
        if (path === '.usabl/bypass-once') {
          refusals.add(path);
          throw new NotRegularFileError(path);
        }
        return null;
      },
      writeFile: async (path) => {
        written.push(path);
      },
      mkdir: async () => {},
      unlink: async () => {},
    },
    pins: memoryPinStore(),
    cwd: () => '/repo/one',
    stdoutWrite: async (text) => {
      stdout.push(text);
    },
    stderrWrite: async (text) => {
      stderr.push(text);
    },
    readConfigBytes: async () => committedConfigBytes(configBytes),
    loadConfig: async () => config,
    buildDeps: async () => makeFakeDeps({ files, headContents: { ...files } }),
    runEngine: async () => verified,
    evaluateDecision: evaluateStopDecision,
    ...(options.withRefusals ? { readRefusals: () => [...refusals].sort() } : {}),
  };
  await runStopHookFromStdin(JSON.stringify({ session_id: 'pipe', stop_hook_active: options.continuation }), ports);
  return { stdout: stdout.join(''), stderr: stderr.join(''), written };
}

describe('a stop that refused to read a path that is not a regular file', () => {
  it('blocks, naming the path, where the checks alone would have verified, and saves no receipt', async () => {
    const out = await stop({ continuation: false, withRefusals: true });

    const answer = JSON.parse(out.stdout.trim()) as { decision: string; reason: string };
    expect(answer.decision).toBe('block');
    expect(answer.reason).toMatch(/^NOT verified - usabl did not read 1 path\(s\) in this repository/u);
    expect(answer.reason).toContain('not regular files: .usabl/bypass-once');
    expect(out.stdout + out.stderr).not.toContain('VERIFIED');
    expect(out.written).toEqual([]);
  });

  it('lets the continuation through with the same paths named, never as VERIFIED', async () => {
    const out = await stop({ continuation: true, withRefusals: true });

    expect(out.stdout).not.toContain('"decision":"block"');
    expect(out.stderr).toMatch(/^NOT verified - usabl did not read 1 path\(s\)/u);
    expect(out.stderr).toContain('continuation already active');
    expect(out.stderr).toContain('not regular files: .usabl/bypass-once');
    expect(out.stdout + out.stderr).not.toContain('VERIFIED');
    expect(out.written).toEqual([]);
  });

  it('is the verified allow when no reader refused a path', async () => {
    const out = await stop({ continuation: false, withRefusals: false });

    expect(out.stdout).not.toContain('"decision":"block"');
    expect(out.stderr).toContain('VERIFIED');
    // The same run saves its receipt, so the cases above show the refusal is what saved none.
    expect(out.written).toEqual(['.usabl/receipt.json']);
  });
});
