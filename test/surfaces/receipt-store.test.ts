import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/contracts/index.js';
import { RECEIPT_DIR, RECEIPT_PATH, loadReceipt, saveReceipt } from '../../src/surfaces/receipt-store.js';

class MemoryReceiptFs {
  private readonly files = new Map<string, string>();
  readonly createdDirs: string[] = [];

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }

  async mkdir(path: string): Promise<void> {
    this.createdDirs.push(path);
  }

  writeRaw(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  fileKeys(): string[] {
    return [...this.files.keys()];
  }
}

const receiptFixture: Receipt = {
  schemaVersion: 1,
  sourceTree: 'tree-123',
  baseRevision: null,
  policyHash: 'hash-abc',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
  surfaces: ['cli'],
  coverage: { checked: ['clusters'], notCovered: [] },
  applicability: [],
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-08-23T00:00:00.000Z',
};

describe('receipt-store', () => {
  it('round-trips a saved receipt', async () => {
    const fs = new MemoryReceiptFs();

    await saveReceipt(fs, receiptFixture);
    const loaded = await loadReceipt(fs);

    expect(loaded).toEqual(receiptFixture);
    expect(fs.fileKeys()).toEqual([RECEIPT_PATH]);
    expect(fs.createdDirs).toContain(RECEIPT_DIR);
  });

  it('returns null when the receipt file is missing', async () => {
    const fs = new MemoryReceiptFs();
    await expect(loadReceipt(fs)).resolves.toBeNull();
  });

  it('returns null when receipt json is corrupt', async () => {
    const fs = new MemoryReceiptFs();
    fs.writeRaw(RECEIPT_PATH, '{"schemaVersion":1,');
    await expect(loadReceipt(fs)).resolves.toBeNull();
  });

  it('rejects a stored receipt missing the required applicability field', async () => {
    // applicability is a required Receipt field, so the runtime validator must enforce it too.
    // An older receipt written before the field existed is stale (its sourceTree will not match
    // current code anyway), so rejecting it is fail-safe: the hook discloses and re-checks.
    const fs = new MemoryReceiptFs();
    const { applicability: _dropped, ...withoutApplicability } = receiptFixture;
    fs.writeRaw(RECEIPT_PATH, JSON.stringify(withoutApplicability));
    await expect(loadReceipt(fs)).resolves.toBeNull();
  });

  it('rejects a stored receipt whose applicability rows are malformed', async () => {
    const fs = new MemoryReceiptFs();
    fs.writeRaw(
      RECEIPT_PATH,
      JSON.stringify({ ...receiptFixture, applicability: [{ screenId: 'clusters', applied: 'lots' }] }),
    );
    await expect(loadReceipt(fs)).resolves.toBeNull();
  });

  it('keeps .usabl state ignored by git', async () => {
    const gitignorePath = new URL('../../.gitignore', import.meta.url);
    const gitignore = await readFile(gitignorePath, 'utf8');

    expect(gitignore).toContain('.usabl/');
  });
});
