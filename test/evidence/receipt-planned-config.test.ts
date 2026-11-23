/**
 * A check plans from the bytes of usabl.config.json it read at its start, and the run binds the
 * bytes it reads when it mints the receipt. A second process can swap the file between the two
 * reads. A receipt is saved only when the file still holds the planned bytes and the receipt binds
 * those same bytes.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { computeLocalFilesHash, UNREADABLE_LOCAL_FILES, withoutLocalFileBinding } from '../../src/evidence/local-files.js';
import { receiptConfigCheck } from '../../src/evidence/planned-config.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
};

const PLANNED = JSON.stringify(config, null, 2) + '\n';
const OTHER = JSON.stringify({ ...config, uiFileGlobs: ['src/other/**'] }, null, 2) + '\n';

function depsWith(configText: string, extra: Record<string, string> = {}): Deps {
  return makeFakeDeps({ files: { 'usabl.config.json': configText, ...extra }, writeTree: 'tree-a', runnerVersion: '0.1.0' });
}

describe('receiptConfigCheck', () => {
  it('saves a receipt that binds the planned bytes while the file still holds them', async () => {
    const deps = depsWith(PLANNED);
    const receipt = { localFilesHash: await computeLocalFilesHash(deps, config) };
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe('bound');
  });

  it('saves none when the file holds other bytes now', async () => {
    const deps = depsWith(OTHER);
    const receipt = { localFilesHash: await computeLocalFilesHash(deps, config) };
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: OTHER })).resolves.toBe('config-changed');
  });

  it('saves none when the file is gone now', async () => {
    const deps = depsWith(PLANNED);
    const receipt = { localFilesHash: await computeLocalFilesHash(deps, config) };
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: null })).resolves.toBe('config-changed');
  });

  // The file held other bytes when the run bound it and the planned bytes again by the save, so
  // only the binding shows the swap. A stop that later finds those other bytes would match it.
  it('saves none when the receipt binds other bytes, even with the planned bytes back in place', async () => {
    const receipt = { localFilesHash: await computeLocalFilesHash(depsWith(OTHER), config) };
    const deps = depsWith(PLANNED);
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe(
      'binding-changed',
    );
  });

  it('saves none when a bound .env file changed after the run bound it', async () => {
    const receipt = { localFilesHash: await computeLocalFilesHash(depsWith(PLANNED, { '.env': 'token=SECRETPOISON\n' }), config) };
    const deps = depsWith(PLANNED, { '.env': 'token=OTHERPOISON\n' });
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe(
      'binding-changed',
    );
  });

  // A receipt whose binding was unreadable, or that has none, never matches a stop, so saving it
  // cannot answer one.
  it('leaves a receipt that binds nothing readable to the rules that already never match it', async () => {
    const deps = depsWith(PLANNED);
    for (const receipt of [{ localFilesHash: UNREADABLE_LOCAL_FILES }, {}]) {
      await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe('bound');
    }
    await expect(
      receiptConfigCheck({ deps: withoutLocalFileBinding(deps), config, receipt: {}, plannedText: PLANNED, currentText: PLANNED }),
    ).resolves.toBe('bound');
  });

  // A check outside the repository root saves its receipt where no stop reads it.
  it('compares only the text when the binding was read outside the repository root', async () => {
    const receipt = { localFilesHash: await computeLocalFilesHash(depsWith(OTHER), config) };
    await expect(receiptConfigCheck({ deps: null, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe('bound');
    await expect(receiptConfigCheck({ deps: null, config, receipt, plannedText: PLANNED, currentText: OTHER })).resolves.toBe(
      'config-changed',
    );
  });

  it('saves none when the receipt binds a readable hash and no reader can check it', async () => {
    const receipt = { localFilesHash: await computeLocalFilesHash(depsWith(PLANNED), config) };
    const deps = withoutLocalFileBinding(depsWith(PLANNED));
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: PLANNED, currentText: PLANNED })).resolves.toBe(
      'binding-changed',
    );
  });

  it('binds the planned bytes as the reader does, so a planned file over the size cap matches nothing', async () => {
    const big = PLANNED + ' '.repeat(16 * 1024 * 1024);
    const deps = depsWith(PLANNED);
    const receipt = { localFilesHash: await computeLocalFilesHash(deps, config) };
    await expect(receiptConfigCheck({ deps, config, receipt, plannedText: big, currentText: big })).resolves.toBe('binding-changed');
  });
});
