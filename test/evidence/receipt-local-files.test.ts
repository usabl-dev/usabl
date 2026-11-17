/**
 * The receipt binds the files the app reads that git does not see: every `.env*` file in the
 * repository root and in each app folder, every path the config lists in `localFiles`, and the
 * bytes of `usabl.config.json`. Each entry is a path, a kind, and a content hash, never the
 * content. A stored receipt matches only while that binding is the same now.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, LocalFileRead, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { withoutLocalFileBinding } from '../../src/evidence/local-files.js';
import { mintReceipt, receiptFailureReasons, verifyReceipt } from '../../src/evidence/receipt.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const CONFIG_TEXT = JSON.stringify(config, null, 2) + '\n';

const mintArgs = {
  surfaces: ['cli'],
  checked: ['clusters'],
  notCovered: [],
  applicability: [],
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
};

const SECRET = 'SECRETPOISON';

function depsWith(files: Record<string, string>): Deps {
  return makeFakeDeps({
    files: { 'usabl.config.json': CONFIG_TEXT, ...files },
    headContents: { 'usabl.config.json': CONFIG_TEXT },
    headBlobs: { 'usabl.config.json': 'blob-config-a' },
    writeTree: 'tree-a',
    runnerVersion: '0.1.0',
  });
}

/** The same deps with some paths read as something other than a regular file. */
function withOther(deps: Deps, paths: readonly string[]): Deps {
  const read = deps.fs.readLocalFile!.bind(deps.fs);
  return {
    ...deps,
    fs: {
      ...deps.fs,
      readLocalFile: async (path: string, maxBytes: number): Promise<LocalFileRead> =>
        paths.includes(path) ? { kind: 'other' } : read(path, maxBytes),
    },
  };
}

const MIB = 1024 * 1024;

/**
 * The same deps with some files read as the given size, as the real reader reads them: a file over
 * the cap it is handed is other, and its bytes are never read.
 */
function withSizes(deps: Deps, sizes: Record<string, number>): Deps {
  const read = deps.fs.readLocalFile!.bind(deps.fs);
  return {
    ...deps,
    fs: {
      ...deps.fs,
      readLocalFile: async (path: string, maxBytes: number): Promise<LocalFileRead> => {
        const size = sizes[path];
        if (size === undefined) return read(path, maxBytes);
        return size > maxBytes ? { kind: 'other' } : { kind: 'file', sha256: `hash-${path}`, size };
      },
    },
  };
}

async function verifyAfter(
  before: Deps,
  after: Deps,
  mintConfig: UsablConfig = config,
  verifyConfig: UsablConfig = mintConfig,
): Promise<string[]> {
  const receipt = await mintReceipt(before, mintConfig, mintArgs);
  return (await verifyReceipt(after, verifyConfig, receipt, 'tree-a')).failedFields;
}

describe('the receipt binds local files git does not see', () => {
  it('matches when there is no .env file at all', async () => {
    expect(await verifyAfter(depsWith({}), depsWith({}))).toEqual([]);
  });

  it('matches when the .env files are unchanged', async () => {
    const files = { '.env': 'A=1\n', '.env.local': 'B=2\n' };
    expect(await verifyAfter(depsWith(files), depsWith(files))).toEqual([]);
  });

  it('does not match after an edit to a .env file', async () => {
    expect(await verifyAfter(depsWith({ '.env.local': 'A=1\n' }), depsWith({ '.env.local': 'A=2\n' }))).toEqual(['localFiles']);
  });

  it('does not match when a .env file appears or disappears', async () => {
    expect(await verifyAfter(depsWith({}), depsWith({ '.env': 'A=1\n' }))).toEqual(['localFiles']);
    expect(await verifyAfter(depsWith({ '.env': 'A=1\n' }), depsWith({}))).toEqual(['localFiles']);
  });

  it('binds the .env files of an app folder below the root', async () => {
    const appConfig: UsablConfig = {
      ...config,
      uiFileGlobs: ['apps/web/src/**/*.tsx'],
      discovery: { routerFile: 'apps/web/src/router.tsx', wideBlastGlobs: [] },
    };
    const manifest = { 'package.json': '{}', 'apps/web/package.json': '{}' };
    expect(
      await verifyAfter(
        depsWith({ ...manifest, 'apps/web/.env.local': 'A=1\n' }),
        depsWith({ ...manifest, 'apps/web/.env.local': 'A=2\n' }),
        appConfig,
      ),
    ).toEqual(['localFiles']);
  });

  it('does not bind a .env file in a folder that is not an app folder', async () => {
    expect(await verifyAfter(depsWith({ 'docs/.env': 'A=1\n' }), depsWith({ 'docs/.env': 'A=2\n' }))).toEqual([]);
  });

  it('does not match after an edit to a listed file, or when it appears', async () => {
    const listed: UsablConfig = { ...config, localFiles: ['public/generated.js'] };
    expect(
      await verifyAfter(depsWith({ 'public/generated.js': 'one' }), depsWith({ 'public/generated.js': 'two' }), listed),
    ).toEqual(['localFiles']);
    expect(await verifyAfter(depsWith({}), depsWith({ 'public/generated.js': 'one' }), listed)).toEqual(['localFiles']);
    expect(await verifyAfter(depsWith({}), depsWith({}), listed)).toEqual([]);
  });

  it('does not match after a config byte change that parses to the same policy', async () => {
    const reformatted = JSON.stringify(config) + '\n';
    expect(JSON.parse(reformatted)).toEqual(JSON.parse(CONFIG_TEXT));
    expect(await verifyAfter(depsWith({}), depsWith({ 'usabl.config.json': reformatted }))).toEqual(['localFiles']);
  });

  it('never matches while a bound path cannot be read as a file, even when nothing changed', async () => {
    const listed: UsablConfig = { ...config, localFiles: ['public/generated'] };
    const deps = withOther(depsWith({ '.env': 'A=1\n' }), ['.env']);
    expect(await verifyAfter(deps, deps)).toEqual(['localFiles']);
    const folder = withOther(depsWith({}), ['public/generated']);
    expect(await verifyAfter(folder, folder, listed)).toEqual(['localFiles']);
  });

  it('binds a .env file whatever the case of its name', async () => {
    for (const name of ['.ENV.local', '.Env']) {
      expect(await verifyAfter(depsWith({ [name]: 'A=1\n' }), depsWith({ [name]: 'A=2\n' }))).toEqual(['localFiles']);
      expect(await verifyAfter(depsWith({}), depsWith({ [name]: 'A=1\n' }))).toEqual(['localFiles']);
    }
  });

  it('binds no file whose name only contains .env', async () => {
    expect(await verifyAfter(depsWith({ 'x.env': 'A=1\n' }), depsWith({ 'x.env': 'A=2\n' }))).toEqual([]);
  });

  it('caps a .env file at 1 MiB and a listed file at 16 MiB', async () => {
    const listed: UsablConfig = { ...config, localFiles: ['public/bundle.js'] };
    const big = withSizes(depsWith({ '.env': 'A=1\n', 'public/bundle.js': 'x' }), { '.env': MIB + 1, 'public/bundle.js': 2 * MIB });
    // The listed file at 2 MiB is under its cap, the .env file at just over 1 MiB is not.
    expect(await verifyAfter(big, big, listed)).toEqual(['localFiles']);
    const fits = withSizes(depsWith({ '.env': 'A=1\n', 'public/bundle.js': 'x' }), { '.env': MIB, 'public/bundle.js': 16 * MIB });
    expect(await verifyAfter(fits, fits, listed)).toEqual([]);
    const over = withSizes(depsWith({ 'public/bundle.js': 'x' }), { 'public/bundle.js': 16 * MIB + 1 });
    expect(await verifyAfter(over, over, listed)).toEqual(['localFiles']);
  });

  it('reads at most 64 MiB across all bound files, so many files at the cap bind nothing that matches', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((name) => `public/${name}.js`);
    const files = Object.fromEntries(names.map((name) => [name, 'x']));
    const four: UsablConfig = { ...config, localFiles: names.slice(0, 4) };
    const five: UsablConfig = { ...config, localFiles: names };
    const sizes = Object.fromEntries(names.map((name) => [name, 15 * MIB]));
    const deps = withSizes(depsWith(files), sizes);
    expect(await verifyAfter(deps, deps, four)).toEqual([]);
    expect(await verifyAfter(deps, deps, five)).toEqual(['localFiles']);
  });

  it('binds nothing in a CI run, and a local stop never matches its receipt', async () => {
    const local = depsWith({ '.env': 'A=1\n' });
    const ci = withoutLocalFileBinding(local);
    const receipt = await mintReceipt(ci, config, mintArgs);
    expect(Object.hasOwn(receipt, 'localFilesHash')).toBe(false);
    expect((await verifyReceipt(local, config, receipt, 'tree-a')).failedFields).toEqual(['localFiles']);
  });

  it('never matches when the file reader cannot tell what is at a path', async () => {
    const deps = depsWith({});
    const { readLocalFile: _read, ...fs } = deps.fs;
    const blind: Deps = { ...deps, fs };
    expect(await verifyAfter(blind, blind)).toEqual(['localFiles']);
  });

  it('never matches when a library caller lists a path outside the repository', async () => {
    const listed = { ...config, localFiles: ['../outside.env'] };
    expect(await verifyAfter(depsWith({}), depsWith({}), listed)).toEqual(['localFiles']);
  });

  it('does not match a receipt minted before this binding, and says why', async () => {
    const deps = depsWith({});
    const { localFilesHash: _hash, ...older } = await mintReceipt(deps, config, mintArgs);
    const verification = await verifyReceipt(deps, config, older, 'tree-a');
    expect(verification.failedFields).toEqual(['localFiles']);
    expect(receiptFailureReasons(older, verification.failedFields, deps.clock())[0]).toContain('.env');
  });

  it('keeps what a bound file holds out of the receipt and the reasons', async () => {
    const listed: UsablConfig = { ...config, localFiles: ['public/generated.js'] };
    const before = depsWith({ '.env.local': `token=${SECRET}\n`, 'public/generated.js': `token=${SECRET}` });
    const after = depsWith({ '.env.local': `token=${SECRET}2\n` });
    const receipt = await mintReceipt(before, listed, mintArgs);
    const text = JSON.stringify(receipt);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('.env');
    expect(text).not.toContain('generated.js');
    const verification = await verifyReceipt(after, listed, receipt, 'tree-a');
    expect(verification.failedFields).toEqual(['localFiles']);
    expect(receiptFailureReasons(receipt, verification.failedFields, after.clock()).join(' ')).not.toContain(SECRET);
  });
});
