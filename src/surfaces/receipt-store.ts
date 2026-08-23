/**
 * Local receipt store for stop-hook fast-path re-checks.
 * This unit persists and loads local state only.
 * It must never mint a verdict, infer trust, or throw on corrupt local files.
 */
import type { Receipt } from '../contracts/index.js';

export const RECEIPT_DIR = '.usabl';
export const RECEIPT_PATH = '.usabl/receipt.json';
export const BYPASS_ONCE_PATH = '.usabl/bypass-once';

export interface ReceiptFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value)) {
    return false;
  }
  const scannerVersions = value['scannerVersions'];
  const coverage = value['coverage'];
  const findingsSummary = value['findingsSummary'];

  return (
    value['schemaVersion'] === 1 &&
    typeof value['sourceTree'] === 'string' &&
    (value['baseRevision'] === null || typeof value['baseRevision'] === 'string') &&
    typeof value['policyHash'] === 'string' &&
    typeof value['runnerVersion'] === 'string' &&
    isRecord(scannerVersions) &&
    typeof scannerVersions['axeCore'] === 'string' &&
    typeof scannerVersions['playwright'] === 'string' &&
    typeof scannerVersions['chromium'] === 'string' &&
    isStringArray(value['surfaces']) &&
    isRecord(coverage) &&
    isStringArray(coverage['checked']) &&
    isStringArray(coverage['notCovered']) &&
    value['verdict'] === 'verified' &&
    isRecord(findingsSummary) &&
    typeof findingsSummary['new'] === 'number' &&
    typeof findingsSummary['carried'] === 'number' &&
    typeof findingsSummary['fixed'] === 'number' &&
    typeof findingsSummary['unverified'] === 'number' &&
    typeof value['activeWaivers'] === 'number' &&
    typeof value['mintedAt'] === 'string'
  );
}

export async function saveReceipt(fs: ReceiptFs, receipt: Receipt): Promise<void> {
  // Receipt files stay local and gitignored so fast-path trust cannot become a committed self-accept.
  await fs.mkdir(RECEIPT_DIR);
  await fs.writeFile(RECEIPT_PATH, JSON.stringify(receipt, null, 2));
}

export async function loadReceipt(fs: Pick<ReceiptFs, 'readFile'>): Promise<Receipt | null> {
  const raw = await fs.readFile(RECEIPT_PATH);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed) ? parsed : null;
  } catch {
    // Corrupt local state returns null so the hook can disclose and continue instead of wedging.
    return null;
  }
}
