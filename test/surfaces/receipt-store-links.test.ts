/**
 * Receipt writes never follow a symbolic link.
 *
 * The receipt lives at .usabl/receipt.json in the work tree. A link committed at that path, or at
 * .usabl itself, used to redirect the write to any file the user can write; in the CI judge the
 * pull request head picks the target. The store now refuses a link at the folder or the file,
 * writes a temp file opened with no-follow and exclusive create, and renames it into place, as the
 * session pin store does. These cases use real links in a temp folder.
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Receipt, Result } from '../../src/contracts/index.js';
import {
  makeReceiptFs,
  RECEIPT_PATH,
  receiptToSave,
  saveReceipt,
} from '../../src/surfaces/receipt-store.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeStopHookRunnerPorts, runStopHookFromStdin, type StopHookRunnerPorts } from '../../src/surfaces/stop-hook-runner.js';
import { testConfig } from '../helpers.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const receipt: Receipt = {
  schemaVersion: 2,
  sourceTree: 'tree-a',
  baseRevision: null,
  historyHead: null,
  policyHash: 'policy',
  runnerVersion: '0.3.0',
  scannerVersions: { axeCore: '4', playwright: '1', chromium: '1' },
  surfaces: ['cli'],
  coverage: { checked: [], notCovered: [] },
  applicability: [],
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-11-10T00:00:00.000Z',
} as unknown as Receipt;

let root = '';
let outside = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'usabl-receipt-root-'));
  outside = await mkdtemp(join(tmpdir(), 'usabl-receipt-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('saveReceipt through the real receipt file system', () => {
  it('writes the receipt and leaves no temp file behind', async () => {
    const saved = await saveReceipt(makeReceiptFs(root), receipt);
    expect(saved).toEqual({ status: 'saved' });
    expect(JSON.parse(await readFile(join(root, RECEIPT_PATH), 'utf8'))).toEqual(receipt);
    expect(await readdir(join(root, '.usabl'))).toEqual(['receipt.json']);
  });

  it('replaces an existing receipt file in place', async () => {
    await mkdir(join(root, '.usabl'));
    await writeFile(join(root, RECEIPT_PATH), 'old');
    expect(await saveReceipt(makeReceiptFs(root), receipt)).toEqual({ status: 'saved' });
    expect(JSON.parse(await readFile(join(root, RECEIPT_PATH), 'utf8'))).toEqual(receipt);
  });

  it('refuses a symbolic link at the receipt path and leaves its target untouched', async () => {
    const target = join(outside, 'victim.txt');
    await writeFile(target, 'keep me');
    await mkdir(join(root, '.usabl'));
    await symlink(target, join(root, RECEIPT_PATH));

    const saved = await saveReceipt(makeReceiptFs(root), receipt);

    expect(saved.status).toBe('refused');
    expect(await readFile(target, 'utf8')).toBe('keep me');
    expect((await lstat(join(root, RECEIPT_PATH))).isSymbolicLink()).toBe(true);
    expect(await readdir(join(root, '.usabl'))).toEqual(['receipt.json']);
  });

  it('refuses a dangling symbolic link at the receipt path and creates nothing at its target', async () => {
    const target = join(outside, 'created-by-redirect.json');
    await mkdir(join(root, '.usabl'));
    await symlink(target, join(root, RECEIPT_PATH));

    const saved = await saveReceipt(makeReceiptFs(root), receipt);

    expect(saved.status).toBe('refused');
    await expect(lstat(target)).rejects.toThrow();
  });

  it('refuses a symbolic link at the .usabl folder and writes nothing through it', async () => {
    await symlink(outside, join(root, '.usabl'));

    const saved = await saveReceipt(makeReceiptFs(root), receipt);

    expect(saved.status).toBe('refused');
    expect(await readdir(outside)).toEqual([]);
  });

  it('says what happened and what to do in the refusal', async () => {
    await mkdir(join(root, '.usabl'));
    await symlink(join(outside, 'x'), join(root, RECEIPT_PATH));
    const saved = await saveReceipt(makeReceiptFs(root), receipt);
    if (saved.status !== 'refused') {
      throw new Error('expected a refusal');
    }
    expect(saved.message).toContain('did not save the receipt');
    expect(saved.message).toContain('symbolic link');
    expect(saved.message).toContain('To fix:');
  });
});

describe('receiptToSave', () => {
  const verified = { verdict: 'verified', receipt } as unknown as Result;

  it('saves the receipt of a verified local run', () => {
    expect(receiptToSave(verified, { ci: false })).toBe(receipt);
  });

  it('does not save a receipt under --ci', () => {
    expect(receiptToSave(verified, { ci: true })).toBeNull();
  });

  it('saves nothing for a run that is not verified', () => {
    expect(receiptToSave({ verdict: 'regression', receipt: null } as unknown as Result, { ci: false })).toBeNull();
  });
});

describe('Stop hook with a symbolic link at the receipt path', () => {
  it('still reports the verified run, writes nothing through the link, and says the receipt was not saved', async () => {
    const target = join(outside, 'victim.txt');
    await writeFile(target, 'keep me');
    await mkdir(join(root, '.usabl'));
    await symlink(target, join(root, RECEIPT_PATH));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const ports: StopHookRunnerPorts = {
      ...makeStopHookRunnerPorts({ startDir: root, env: {} }),
      pins: memoryPinStore(),
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      readConfigBytes: async () => committedConfigBytes(),
      loadConfig: async () => testConfig(),
      buildDeps: async () =>
        makeFakeDeps({ files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } }),
      runEngine: async () =>
        ({
          schemaVersion: 'usabl.result.v1',
          verdict: 'verified',
          summary: 'verified: 0 gating finding(s)',
          screens: [],
          coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
          findings: [],
          receipt,
          dirtyGuardedPaths: [],
          exitCode: 0,
          accessibilityVerdict: 'verified',
          accessibilityExitCode: 0,
          paidDownCount: 0,
          floorHeadroom: [],
          floorUnconfirmed: [],
        }) as Result,
    };

    expect(await runStopHookFromStdin('{}', ports)).toBe(0);

    expect(await readFile(target, 'utf8')).toBe('keep me');
    expect(stdout.join('')).not.toContain('"decision":"block"');
    const text = stderr.join('');
    expect(text).toContain('VERIFIED');
    expect(text).toContain('did not save the receipt');
    expect(text).not.toContain('stop hook error');
  });
});

// Any failed save, not only a link, leaves the verdict as it was. The reason comes from the file
// system and can name a path, so only its first line is printed, inside the untrusted frame.
describe('A receipt save that fails for another reason', () => {
  function eacces(): Error {
    return Object.assign(new Error("EACCES: permission denied, open '/repo/.usabl/.receipt.json.tmp'\nsecond line"), {
      code: 'EACCES',
    });
  }

  it('returns the not-saved notice with the first line of the reason inside the frame', async () => {
    const saved = await saveReceipt(
      {
        readFile: async () => null,
        mkdir: async () => {},
        writeFile: async () => {
          throw eacces();
        },
      },
      receipt,
    );
    expect(saved.status).toBe('refused');
    const message = saved.status === 'refused' ? saved.message : '';
    expect(message.startsWith('NOT saved - usabl did not save the receipt for this run')).toBe(true);
    expect(message).toContain('The verdict of this run stands');
    const frameStart = message.indexOf('[BEGIN UNTRUSTED TEXT');
    expect(frameStart).toBeGreaterThan(0);
    expect(message.indexOf('EACCES: permission denied')).toBeGreaterThan(frameStart);
    expect(message).not.toContain('second line');
  });

  it('still reads VERIFIED on the stop, with the not-saved notice after it', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ports: StopHookRunnerPorts = {
      ...makeStopHookRunnerPorts({ startDir: root, env: {} }),
      fs: {
        readFile: async () => null,
        mkdir: async () => {},
        writeFile: async () => {
          throw eacces();
        },
        unlink: async () => {},
      },
      pins: memoryPinStore(),
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      readConfigBytes: async () => committedConfigBytes(),
      loadConfig: async () => testConfig(),
      buildDeps: async () =>
        makeFakeDeps({ files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } }),
      runEngine: async () =>
        ({
          schemaVersion: 'usabl.result.v1',
          verdict: 'verified',
          summary: 'verified: 0 gating finding(s)',
          screens: [],
          coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
          findings: [],
          receipt,
          dirtyGuardedPaths: [],
          exitCode: 0,
          accessibilityVerdict: 'verified',
          accessibilityExitCode: 0,
          paidDownCount: 0,
          floorHeadroom: [],
          floorUnconfirmed: [],
        }) as Result,
    };

    expect(await runStopHookFromStdin('{"session_id":"session-one"}', ports)).toBe(0);

    const text = stderr.join('');
    expect(text.startsWith('VERIFIED (exit 0)')).toBe(true);
    expect(text).not.toContain('stop hook error');
    expect(text.indexOf('NOT saved - usabl did not save the receipt')).toBeGreaterThan(0);
    const payload = JSON.parse(stdout.join('').trim()) as { systemMessage?: string };
    expect(payload.systemMessage).toBe(text.trimEnd());
  });
});
