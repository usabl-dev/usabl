import { describe, expect, it } from 'vitest';
import type { Deps, LocalFileRead, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { computeLocalFilesHash, UNREADABLE_LOCAL_FILES, withoutLocalFileBinding } from '../src/evidence/local-files.js';
import { run } from '../src/run.js';

// Run level: the run reads the local files hash (the .env files, the paths in localFiles, and the
// config bytes, which git does not see) before it plans and again at the second tree read. A file
// that changed in between was not the file the scan saw, so the run is not covered and mints no
// receipt. The receipt binds the first read, and mint never reads these files itself.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const cleanScan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

const SECRET = 'SECRETPOISON';

function baseFiles(): Record<string, string> {
  return {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    '.env': `API_TOKEN=${SECRET}\n`,
  };
}

// The fake file system reads from this object, so a test edits a file by writing into it.
function depsOver(files: Record<string, string>): Deps {
  return makeFakeDeps({
    files,
    headContents: { ...files },
    writeTree: 'tree-steady',
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: cleanScan },
  });
}

// An edit that lands during the scan of the screen, the way a watcher or a background job writes
// `.env` while the browser is on the page.
function withEditDuringScan(deps: Deps, edit: () => void): Deps {
  return {
    ...deps,
    checkRunner: {
      ...deps.checkRunner,
      scan: async (target) => {
        const scan = await deps.checkRunner.scan(target);
        edit();
        return scan;
      },
    },
  };
}

// An edit that lands after the second read: the run reads its clock for the gate after it.
function withEditAfterTheCheck(deps: Deps, edit: () => void): Deps {
  return {
    ...deps,
    clock: () => {
      edit();
      return deps.clock();
    },
  };
}

describe('a local file that changed during the scan', () => {
  it('is not covered, names a local file the receipt binds, and mints no receipt', async () => {
    const files = baseFiles();
    const deps = withEditDuringScan(depsOver(files), () => {
      files['.env'] = `API_TOKEN=${SECRET}-changed\n`;
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('not_covered');
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === 'local files');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('a local file the receipt binds');
    expect(gap?.reason).toContain('While usabl was checking');
    expect(gap?.reason).toContain('may not match what the app now does');
    expect(gap?.reason).toContain('run usabl again');
    // The gap never names the file, and nothing of its bytes reaches the Result.
    expect(gap?.reason).not.toContain('.env');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('is not covered when a .env file appears during the scan', async () => {
    const files = baseFiles();
    const deps = withEditDuringScan(depsOver(files), () => {
      files['.env.local'] = 'A=1\n';
    });

    const result = await run(deps, config);

    expect(result.verdict).not.toBe('verified');
    expect(result.receipt).toBeNull();
    expect(result.coverage.gaps.some((g) => g.ref === 'local files')).toBe(true);
  });

  it('is not covered when a bound file becomes unreadable during the scan', async () => {
    const files = baseFiles();
    let unreadable = false;
    const plain = depsOver(files);
    const read = plain.fs.readLocalFile!.bind(plain.fs);
    const deps = withEditDuringScan(
      {
        ...plain,
        fs: {
          ...plain.fs,
          readLocalFile: async (path: string, maxBytes: number): Promise<LocalFileRead> =>
            unreadable && path === '.env' ? { kind: 'other' } : read(path, maxBytes),
        },
      },
      () => {
        unreadable = true;
      },
    );

    const result = await run(deps, config);

    expect(result.verdict).not.toBe('verified');
    expect(result.receipt).toBeNull();
    expect(result.coverage.gaps.some((g) => g.ref === 'local files')).toBe(true);
  });
});

describe('local files that did not change during the scan', () => {
  it('mint a receipt with the hash read before planning', async () => {
    const files = baseFiles();
    const deps = depsOver(files);
    const before = await computeLocalFilesHash(deps, config);

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.receipt?.localFilesHash).toBe(before);
    expect(before).not.toBe(UNREADABLE_LOCAL_FILES);
  });

  it('bind the files the scan saw, not ones read after the check', async () => {
    const files = baseFiles();
    const plain = depsOver(files);
    const before = await computeLocalFilesHash(plain, config);
    const deps = withEditAfterTheCheck(plain, () => {
      files['.env'] = `API_TOKEN=${SECRET}-later\n`;
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.localFilesHash).toBe(before);
    // The edit after the check moved the files away from the bound value.
    expect(await computeLocalFilesHash(plain, config)).not.toBe(before);
  });

  it('bind the unreadable value when a file could not be read at either read, so the receipt never matches', async () => {
    const files = baseFiles();
    const plain = depsOver(files);
    const deps: Deps = {
      ...plain,
      fs: { ...plain.fs, readLocalFile: async (): Promise<LocalFileRead> => ({ kind: 'other' }) },
    };

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.localFilesHash).toBe(UNREADABLE_LOCAL_FILES);
  });
});

describe('a --ci run', () => {
  it('binds no local files and reads none, even when one changes during the scan', async () => {
    const files = baseFiles();
    const deps = withEditDuringScan(withoutLocalFileBinding(depsOver(files)), () => {
      files['.env'] = `API_TOKEN=${SECRET}-changed\n`;
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.receipt).not.toBeNull();
    expect(result.receipt).not.toHaveProperty('localFilesHash');
    expect(result.coverage.gaps.some((g) => g.ref === 'local files')).toBe(false);
  });
});
