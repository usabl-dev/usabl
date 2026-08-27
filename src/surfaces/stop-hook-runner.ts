#!/usr/bin/env node
/**
 * Stop-hook runner for Claude Code protocol integration.
 * This unit projects existing trust signals and prints protocol output only.
 * It must never block via exit code or mint a verdict outside the gate.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Deps, Result, UsablConfig } from '../contracts/index.js';
import { buildDeps } from '../deps/build.js';
import { verifyReceipt } from '../evidence/receipt.js';
import { run } from '../run.js';
import { checkGuard, computeSessionPins, diffSessionPins, type SessionPins } from '../trust/guard.js';
import { loadConfig } from '../cli.js';
import { evaluateStopDecision, type HookContext } from './stop-hook.js';
import { BYPASS_ONCE_PATH, loadReceipt, saveReceipt, type ReceiptFs } from './receipt-store.js';

export interface StopHookInput {
  stopHookActive: boolean;
  sessionId: string | null;
}

export interface StopHookRunnerFs extends ReceiptFs {
  unlink(path: string): Promise<void>;
}

export interface StopHookRunnerPorts {
  fs: StopHookRunnerFs;
  tmpDir: () => string;
  stdoutWrite: (text: string) => Promise<void> | void;
  stderrWrite: (text: string) => Promise<void> | void;
  loadConfig: () => Promise<UsablConfig>;
  buildDeps: (config: UsablConfig) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
  evaluateDecision: (result: Result, ctx: HookContext) => { block: boolean; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStopHookInput(raw: unknown): StopHookInput {
  if (!isRecord(raw)) {
    return { stopHookActive: false, sessionId: null };
  }
  const stopHookActive = raw['stop_hook_active'] === true;
  const sessionIdRaw = raw['session_id'];
  const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;
  return { stopHookActive, sessionId };
}

function isSessionPins(value: unknown): value is SessionPins {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function sessionPinPath(tmpDirPath: string, sessionId: string): string {
  return join(tmpDirPath, `usabl-pins-${sessionId}.json`);
}

function parseSessionId(raw: string | null): { sessionId: string | null; warning: string | null } {
  if (raw === null) {
    return { sessionId: null, warning: null };
  }
  const candidate = raw.trim();
  const safePattern = /^[A-Za-z0-9._-]{1,128}$/;
  if (!safePattern.test(candidate) || candidate.includes('..')) {
    return {
      sessionId: null,
      warning: `NOT verified - ignored unsafe session_id: ${JSON.stringify(raw)}.`,
    };
  }
  return { sessionId: candidate, warning: null };
}

function isWithinDir(baseDir: string, path: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + sep);
}

async function writeStderr(ports: StopHookRunnerPorts, text: string): Promise<void> {
  await ports.stderrWrite(text.endsWith('\n') ? text : `${text}\n`);
}

async function emitBlock(ports: StopHookRunnerPorts, reason: string): Promise<void> {
  // Claude Code only blocks when stdout receives a decision object, so exit codes stay non-blocking.
  await ports.stdoutWrite(JSON.stringify({ decision: 'block', reason }) + '\n');
}

async function consumeBypassOnce(fs: StopHookRunnerFs): Promise<boolean> {
  const bypass = await fs.readFile(BYPASS_ONCE_PATH);
  if (bypass === null) {
    return false;
  }
  await fs.unlink(BYPASS_ONCE_PATH);
  return true;
}

async function readSessionPins(fs: StopHookRunnerFs, path: string): Promise<SessionPins | null> {
  const raw = await fs.readFile(path);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionPins(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSessionPins(fs: StopHookRunnerFs, path: string, pins: SessionPins): Promise<void> {
  await fs.writeFile(path, JSON.stringify(pins, null, 2));
}

async function verifyStoredReceipt(
  ports: StopHookRunnerPorts,
  deps: Deps,
  config: UsablConfig,
): Promise<{ verified: boolean; details: string }> {
  const receipt = await loadReceipt(ports.fs);
  if (receipt === null) {
    return { verified: false, details: 'no local receipt found' };
  }

  // Fast-path verification reuses the same verifier as run() so trust rules cannot diverge.
  const currentSourceTree = await deps.git.writeTree();
  const verification = await verifyReceipt(deps, config, receipt, currentSourceTree);
  if (verification.valid) {
    return { verified: true, details: `verified receipt sourceTree ${receipt.sourceTree}` };
  }
  return {
    verified: false,
    details: `receipt mismatch in ${verification.failedFields.join(', ') || 'unknown field'}`,
  };
}

function defaultFs(): StopHookRunnerFs {
  return {
    readFile: async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    writeFile: async (path: string, contents: string) => {
      await writeFile(path, contents, 'utf8');
    },
    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    unlink: async (path: string) => {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    },
  };
}

export function makeStopHookRunnerPorts(): StopHookRunnerPorts {
  return {
    fs: defaultFs(),
    tmpDir: () => tmpdir(),
    stdoutWrite: async (text: string) => {
      process.stdout.write(text);
    },
    stderrWrite: async (text: string) => {
      process.stderr.write(text);
    },
    loadConfig: async () => loadConfig(),
    buildDeps: async (config: UsablConfig) => buildDeps(config),
    runEngine: async (deps: Deps, config: UsablConfig) => run(deps, config),
    evaluateDecision: evaluateStopDecision,
  };
}

export async function runStopHook(input: StopHookInput, ports: StopHookRunnerPorts): Promise<number> {
  let deps: Deps | null = null;
  try {
    if (await consumeBypassOnce(ports.fs)) {
      // One-shot bypass is loud so temporary overrides cannot become sticky silent greens.
      await writeStderr(ports, 'NOT verified - BYPASS consumed for this stop only.');
      return 0;
    }

    const config = await ports.loadConfig();
    deps = await ports.buildDeps(config);
    const dirtyGuardedPaths = await checkGuard(deps, config);
    if (dirtyGuardedPaths.length === 0) {
      // Receipt trust binds committed state, while checkGuard catches local guarded edits before any fast allow.
      const receiptCheck = await verifyStoredReceipt(ports, deps, config);
      if (receiptCheck.verified) {
        await writeStderr(ports, receiptCheck.details);
        return 0;
      }
    }

    const parsedSession = parseSessionId(input.sessionId);
    if (parsedSession.warning !== null) {
      await writeStderr(ports, parsedSession.warning);
    }
    if (parsedSession.sessionId !== null) {
      const pinsPath = sessionPinPath(ports.tmpDir(), parsedSession.sessionId);
      if (!isWithinDir(ports.tmpDir(), pinsPath)) {
        await writeStderr(ports, `NOT verified - ignored unsafe session_id: ${JSON.stringify(parsedSession.sessionId)}.`);
      } else {
        const [previousPins, nextPins] = await Promise.all([
          readSessionPins(ports.fs, pinsPath),
          computeSessionPins(deps, config),
        ]);

        if (previousPins === null) {
          await writeSessionPins(ports.fs, pinsPath, nextPins);
        } else {
          const drift = diffSessionPins(previousPins, nextPins);
          if (drift.length > 0) {
            const message = `NOT verified - guarded policy drift during this session: ${drift.join(', ')}`;
            if (input.stopHookActive) {
              // Allow one continuation while active to avoid recursive stop-hook loops.
              // We keep the previous pins so a retry cannot convert detected drift into a silent allow.
              await writeStderr(ports, `${message}. continuation already active.`);
              return 0;
            }
            // Drift is a trust boundary. Overwriting pins here would let "retry stop" clear the evidence.
            await emitBlock(ports, message);
            return 0;
          }
          await writeSessionPins(ports.fs, pinsPath, nextPins);
        }
      }
    }

    const result = await ports.runEngine(deps, config);
    if (result.verdict === 'verified' && result.receipt !== null) {
      await saveReceipt(ports.fs, result.receipt);
    }

    const decision = ports.evaluateDecision(result, { stopHookActive: input.stopHookActive });
    if (decision.block) {
      await emitBlock(ports, decision.message);
      return 0;
    }

    await writeStderr(ports, decision.message);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Hook errors fail open with disclosure because a wedged stop hook is worse than an honest unverified allow.
    await writeStderr(ports, `NOT verified - stop hook error: ${message}`);
    return 0;
  } finally {
    if (deps !== null) {
      await deps.browser.close();
    }
  }
}

export async function runStopHookFromStdin(
  stdinText: string,
  ports: StopHookRunnerPorts = makeStopHookRunnerPorts(),
): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(stdinText);
    return runStopHook(parseStopHookInput(parsed), ports);
  } catch {
    await writeStderr(ports, 'NOT verified - invalid stop hook input JSON.');
    return 0;
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

export async function main(): Promise<number> {
  return runStopHookFromStdin(await readStdin());
}
