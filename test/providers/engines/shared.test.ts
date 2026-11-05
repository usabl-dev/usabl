/**
 * The seams both commercial engines share: finding the vendor package the way the dynamic import
 * finds it, turning every load failure into a message with a fix, bounding every vendor call with
 * a timeout, and redacting credential values.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePage } from '../../../src/deps/fakes.js';
import {
  ENGINE_CALL_TIMEOUT_MS,
  loadEngineModule,
  makeRedactor,
  packageLookupDirs,
  playwrightPageOf,
  registerPlaywrightPage,
  probeInstalledPackage,
  withEngineTimeout,
  type EngineLabel,
  type PackageProbeFs,
} from '../../../src/providers/engines/shared.js';

const LABEL: EngineLabel = {
  vendor: 'Acme Scanner',
  packageName: '@acme/scanner',
  configKey: 'engines.acme',
  registry: "Acme's registry",
};

function memoryFs(files: Record<string, string>): PackageProbeFs {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join('/') || '/');
    }
  }
  return {
    isDirectory: async (path) => dirs.has(path),
    readFile: async (path) => files[path] ?? null,
  };
}

describe('packageLookupDirs', () => {
  it('walks node_modules from the starting folder up to the root, and nothing else', () => {
    expect(packageLookupDirs('@acme/scanner', '/srv/app/node_modules/usabl/dist')).toEqual([
      '/srv/app/node_modules/usabl/dist/node_modules/@acme/scanner',
      '/srv/app/node_modules/usabl/node_modules/@acme/scanner',
      '/srv/app/node_modules/node_modules/@acme/scanner',
      '/srv/app/node_modules/@acme/scanner',
      '/srv/node_modules/@acme/scanner',
      '/node_modules/@acme/scanner',
    ]);
  });
});

describe('probeInstalledPackage', () => {
  it('finds the nearest copy and reads its version without loading it', async () => {
    const fs = memoryFs({
      '/srv/app/node_modules/@acme/scanner/package.json': JSON.stringify({ version: '4.11.2' }),
      '/srv/node_modules/@acme/scanner/package.json': JSON.stringify({ version: '1.0.0' }),
    });
    expect(await probeInstalledPackage('@acme/scanner', { fromDir: '/srv/app/node_modules/usabl/dist', fs })).toEqual({
      state: 'installed',
      version: '4.11.2',
      missingDependencies: [],
    });
  });

  it('never looks in NODE_PATH or a global folder, which the dynamic import does not read', async () => {
    const fs = memoryFs({ '/usr/lib/node_modules/@acme/scanner/package.json': JSON.stringify({ version: '1.0.0' }) });
    const previous = process.env.NODE_PATH;
    process.env.NODE_PATH = '/usr/lib/node_modules';
    try {
      expect(await probeInstalledPackage('@acme/scanner', { fromDir: '/srv/app/dist', fs })).toEqual({
        state: 'not-installed',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_PATH;
      } else {
        process.env.NODE_PATH = previous;
      }
    }
  });

  it('names a declared dependency that does not resolve from the vendor folder', async () => {
    const fs = memoryFs({
      '/srv/app/node_modules/@acme/scanner/package.json': JSON.stringify({
        version: '2.0.0',
        dependencies: { 'acme-core': '^2', 'present-dep': '^1' },
        peerDependencies: { playwright: '>=1', 'optional-peer': '*' },
        peerDependenciesMeta: { 'optional-peer': { optional: true } },
      }),
      '/srv/app/node_modules/present-dep/package.json': '{}',
    });
    expect(await probeInstalledPackage('@acme/scanner', { fromDir: '/srv/app/dist', fs })).toEqual({
      state: 'installed',
      version: '2.0.0',
      missingDependencies: ['acme-core', 'playwright'],
    });
  });

  it('reads an unreadable or versionless package.json as version unknown', async () => {
    const fs = memoryFs({ '/srv/app/node_modules/@acme/scanner/package.json': '{not json' });
    expect(await probeInstalledPackage('@acme/scanner', { fromDir: '/srv/app/dist', fs })).toEqual({
      state: 'installed',
      version: 'unknown',
      missingDependencies: [],
    });
  });

  it('finds axe-core, which usabl itself depends on, from its own source folder', async () => {
    const found = await probeInstalledPackage('axe-core');
    expect(found).toMatchObject({ state: 'installed', version: '4.13.0' });
    expect(await probeInstalledPackage('@axe-devtools/playwright')).toEqual({ state: 'not-installed' });
  });
});

describe('loadEngineModule', () => {
  const identity = (text: string): string => text;
  const notFound = (name: string): Error =>
    Object.assign(new Error(`Cannot find package '${name}' imported from /srv/app/node_modules/x/index.js`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

  it('says a package that is not there is not installed, and how to get out', async () => {
    await expect(
      loadEngineModule(LABEL, {
        load: async () => Promise.reject(notFound('@acme/scanner')),
        probe: async () => ({ state: 'not-installed' }),
        redact: identity,
      }),
    ).rejects.toThrow(
      "Acme Scanner is turned on in usabl.config.json but @acme/scanner is not installed. Install it from Acme's registry, or set engines.acme.enabled to false.",
    );
  });

  it('names a missing dependency of the vendor package apart from not installed', async () => {
    await expect(
      loadEngineModule(LABEL, {
        load: async () => Promise.reject(notFound('acme-core')),
        probe: async () => ({ state: 'installed', version: '2.0.0', missingDependencies: [] }),
        redact: identity,
      }),
    ).rejects.toThrow(
      '@acme/scanner 2.0.0 is installed but could not load, because acme-core, a package it needs, is not installed. Reinstall @acme/scanner with its dependencies, or set engines.acme.enabled to false.',
    );
  });

  it('names the dependencies the install is missing when the error does not say which', async () => {
    await expect(
      loadEngineModule(LABEL, {
        load: async () => Promise.reject(new Error('boom')),
        probe: async () => ({ state: 'installed', version: '2.0.0', missingDependencies: ['acme-core', 'playwright'] }),
        redact: identity,
      }),
    ).rejects.toThrow('because acme-core and playwright, packages it needs, are not installed');
  });

  it('says a package that is there but throws on import failed to load, redacted', async () => {
    await expect(
      loadEngineModule(LABEL, {
        load: async () => Promise.reject(new Error('bad build with token s3cret')),
        probe: async () => ({ state: 'installed', version: '2.0.0', missingDependencies: [] }),
        redact: makeRedactor(['s3cret']),
      }),
    ).rejects.toThrow(
      '@acme/scanner 2.0.0 is installed but failed to load: bad build with token [redacted]. Check the installed version, or set engines.acme.enabled to false.',
    );
  });

  it('reads a not-found error for the vendor package itself as not installed even when a copy was seen', async () => {
    // The probe and the loader disagree only when something outside both changed the tree, which
    // is still the not-installed case for the operator.
    await expect(
      loadEngineModule(LABEL, {
        load: async () => Promise.reject(notFound('@acme/scanner')),
        probe: async () => ({ state: 'installed', version: '2.0.0', missingDependencies: [] }),
        redact: identity,
      }),
    ).rejects.toThrow('@acme/scanner is not installed');
  });

  it('bounds a load that never settles', async () => {
    await expect(
      loadEngineModule(LABEL, {
        load: () => new Promise(() => {}),
        probe: async () => ({ state: 'installed', version: '2.0.0', missingDependencies: [] }),
        redact: identity,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('Acme Scanner did not finish loading @acme/scanner within 20 ms');
  });
});

describe('withEngineTimeout', () => {
  it('has a budget that bounds a hung license server well inside a CI job', () => {
    expect(ENGINE_CALL_TIMEOUT_MS).toBe(60_000);
  });

  it('passes a value through and rejects with a named step when the call hangs', async () => {
    expect(await withEngineTimeout(LABEL, 'analysis', Promise.resolve(7), 20)).toBe(7);
    const started = Date.now();
    await expect(withEngineTimeout(LABEL, 'analysis', new Promise(() => {}), 30)).rejects.toThrow(
      'Acme Scanner did not finish analysis within 30 ms, so it checked nothing on this screen. Check its license server and the page, or set engines.acme.enabled to false.',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('swallows a late rejection from the call it gave up on', async () => {
    const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 40));
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await expect(withEngineTimeout(LABEL, 'analysis', late, 10)).rejects.toThrow('did not finish');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('makeRedactor', () => {
  it('replaces every occurrence of every non-empty secret', () => {
    const redact = makeRedactor(['abc', '', 'xyz']);
    expect(redact('abc and xyz and abc')).toBe('[redacted] and [redacted] and [redacted]');
  });
});

describe('the Playwright page bridge', () => {
  it('hands back the Playwright page registered for a usabl page, and nothing for any other', () => {
    const page = makeFakePage();
    const pw = { fake: 'playwright page' };
    expect(playwrightPageOf(page)).toBeNull();
    registerPlaywrightPage(page, pw);
    expect(playwrightPageOf(page)).toBe(pw);
    expect(playwrightPageOf(makeFakePage())).toBeNull();
  });

  it('is not a property of the page, so a copy or a page that names one does not carry it', () => {
    const page = makeFakePage();
    registerPlaywrightPage(page, { fake: 'playwright page' });
    expect(Object.keys(page)).not.toContain('playwrightPage');
    expect(playwrightPageOf({ ...page })).toBeNull();
    const forged = Object.assign(makeFakePage(), { playwrightPage: () => ({ forged: true }) });
    expect(playwrightPageOf(forged)).toBeNull();
  });
});
