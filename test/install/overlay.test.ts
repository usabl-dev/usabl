/**
 * Overlay install drafts must be proven from an in-memory app fixture.
 * The generator writes a Vite config draft only when none exists, no-ops when the
 * overlay is already wired, and refuses to touch an operator config it cannot patch
 * without risk. A refusal that hands over the exact two lines is safer than a
 * mangled config, so the refusal guard is asserted to be load-bearing here.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import {
  OVERLAY_DRAFT,
  isOverlayWired,
  planOverlay,
  writeOverlay,
} from '../../src/install/overlay.js';

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

// A Vite app with no Vite config: its dev script runs the vite command, which reads vite.config.ts
// when one appears. Install writes the draft only when it can see the app runs Vite.
const VITE_APP_PACKAGE = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } });

describe('planOverlay', () => {
  it('plans a full draft when the app runs Vite and no vite config exists', async () => {
    const plan = await planOverlay(memoryFs({ 'package.json': VITE_APP_PACKAGE }));
    expect(plan.action).toBe('write');
    expect(plan.path).toBe('vite.config.ts');
    if (plan.action === 'write') {
      expect(plan.draft).toContain("import { usablVitePluginFromConfig } from 'usabl/vite'");
      expect(plan.draft).toContain('usablVitePluginFromConfig({ cwd: import.meta.dirname })');
    }
  });

  it('reports already wired when the import and plugin call are both present', async () => {
    const plan = await planOverlay(memoryFs({ 'vite.config.ts': OVERLAY_DRAFT }));
    expect(plan.action).toBe('already-wired');
  });

  it('detects an already wired config among the alternate candidates', async () => {
    const wired = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'
export default defineConfig({ plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })] })
`;
    const plan = await planOverlay(memoryFs({ 'vite.config.mts': wired }));
    expect(plan.action).toBe('already-wired');
    expect(plan.path).toBe('vite.config.mts');
  });

  it('refuses when a config exists but the overlay is not wired', async () => {
    const plan = await planOverlay(
      memoryFs({ 'vite.config.ts': "import { defineConfig } from 'vite'\nexport default defineConfig({})\n" }),
    );
    expect(plan.action).toBe('refuse');
    expect(plan.path).toBe('vite.config.ts');
  });

  it('refuses a config whose only plugin wiring is commented out', async () => {
    // The import is active but the plugin call is commented out, so the overlay is off.
    // A comment-blind scan would call this already-wired; the fix must refuse instead.
    const commented = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'
export default defineConfig({
  plugins: [
    // usablVitePluginFromConfig({ cwd: import.meta.dirname }),
  ],
})
`;
    const plan = await planOverlay(memoryFs({ 'vite.config.ts': commented }));
    expect(plan.action).toBe('refuse');
  });

  it('refuses an unwired vite.config.cts instead of shadowing it with a fresh config', async () => {
    // If .cts were not a candidate, planOverlay would write a fresh vite.config.ts that Vite
    // loads first, silently shadowing the operator's real config. It must refuse instead.
    const cts = "import { defineConfig } from 'vite'\nexport default defineConfig({})\n";
    const plan = await planOverlay(memoryFs({ 'vite.config.cts': cts }));
    expect(plan.action).toBe('refuse');
    expect(plan.path).toBe('vite.config.cts');
  });
});

describe('writeOverlay', () => {
  it('writes the draft when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({ 'package.json': VITE_APP_PACKAGE });
    const first = await writeOverlay(fs, await planOverlay(fs));
    expect(first.exitCode).toBe(0);
    expect(first.action).toBe('written');
    expect(fs.store['vite.config.ts']).toBe(OVERLAY_DRAFT);

    const second = await writeOverlay(fs, await planOverlay(fs));
    expect(second.exitCode).toBe(0);
    expect(second.action).toBe('already-wired');
    expect(fs.store['vite.config.ts']).toBe(OVERLAY_DRAFT);
  });

  it('refuses and prints the exact manual snippet without touching the operator config', async () => {
    const original = "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n";
    const fs = memoryFs({ 'vite.config.ts': original });
    const result = await writeOverlay(fs, await planOverlay(fs));

    // Load-bearing guard: exit 2 and the original bytes must be untouched. If the
    // generator ever overwrote an unwired operator config, both assertions flip red.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(fs.store['vite.config.ts']).toBe(original);
    expect(result.message).toContain("import { usablVitePluginFromConfig } from 'usabl/vite'");
    expect(result.message).toContain('usablVitePluginFromConfig({ cwd: import.meta.dirname })');
  });

  it('refuses an unwired vite.config.cts without writing a shadowing vite.config.ts', async () => {
    const cts = "import { defineConfig } from 'vite'\nexport default defineConfig({})\n";
    const fs = memoryFs({ 'vite.config.cts': cts });
    const result = await writeOverlay(fs, await planOverlay(fs));

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    // The real .cts config is untouched and no fresh vite.config.ts was written to shadow it.
    expect(fs.store['vite.config.cts']).toBe(cts);
    expect(fs.store['vite.config.ts']).toBeUndefined();
  });
});

describe('isOverlayWired', () => {
  it('requires both the import and the plugin call', () => {
    expect(isOverlayWired(OVERLAY_DRAFT)).toBe(true);
    expect(isOverlayWired("import { usablVitePluginFromConfig } from 'usabl/vite'\n")).toBe(false);
    expect(isOverlayWired('usablVitePluginFromConfig({ cwd: import.meta.dirname })\n')).toBe(false);
  });

  it('ignores commented-out or quoted mentions of the plugin', () => {
    // Import active, call commented out: the overlay is off, so this is not wired.
    const commentedCall = `import { usablVitePluginFromConfig } from 'usabl/vite'
export default { plugins: [
  // usablVitePluginFromConfig({ cwd: import.meta.dirname }),
] }
`;
    expect(isOverlayWired(commentedCall)).toBe(false);

    // The call named only inside a string is data, not wiring.
    const quotedMention = `import { defineConfig } from 'vite'
const note = 'call usablVitePluginFromConfig() to wire the overlay'
export default defineConfig({ plugins: [] })
`;
    expect(isOverlayWired(quotedMention)).toBe(false);

    // A real wiring next to a URL string still reads as wired: comment detection is
    // string-aware, so the // inside the URL is not mistaken for a comment.
    const wiredWithUrl = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'
const site = 'https://example.com/app'
export default defineConfig({ plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })] })
`;
    expect(isOverlayWired(wiredWithUrl)).toBe(true);
  });

  it('recognises a multi-line import as wired', () => {
    // A legitimately wired config whose import is broken across lines was reported as not wired
    // because [^;\n]* stops at newlines. The fix allows newlines within a single import statement.
    const multiLine = `import { defineConfig } from 'vite'
import {
  usablVitePluginFromConfig,
} from 'usabl/vite'
export default defineConfig({
  plugins: [
    usablVitePluginFromConfig({ cwd: import.meta.dirname }),
  ],
})
`;
    expect(isOverlayWired(multiLine)).toBe(true);
  });

  it('recognises a multi-line import with additional named exports as wired', () => {
    // Multiple bindings on separate lines — a common formatter output.
    const multiLineMultiBinding = `import { defineConfig } from 'vite'
import {
  someOtherExport,
  usablVitePluginFromConfig,
  anotherExport,
} from 'usabl/vite'
export default defineConfig({
  plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })],
})
`;
    expect(isOverlayWired(multiLineMultiBinding)).toBe(true);
  });

  it('recognises a multi-line import where from is on its own line as wired', () => {
    // Some formatters put the closing brace and from keyword on the same line,
    // others put the binding list on separate lines with from at the end.
    const fromOnOwnLine = `import { defineConfig } from 'vite'
import {
  usablVitePluginFromConfig
}
  from 'usabl/vite'
export default defineConfig({
  plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })],
})
`;
    expect(isOverlayWired(fromOnOwnLine)).toBe(true);
  });

  it('still refuses when the multi-line import is commented out', () => {
    // Commenting out a multi-line import must still be rejected, not accepted.
    const commentedMultiLine = `import { defineConfig } from 'vite'
/*
import {
  usablVitePluginFromConfig,
} from 'usabl/vite'
*/
export default defineConfig({ plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })] })
`;
    expect(isOverlayWired(commentedMultiLine)).toBe(false);
  });

  it('refuses when the binding and the usabl/vite specifier are in different statements', () => {
    // Semicolon-free source must not let the detector borrow the binding from an import of a
    // different module and the specifier from an unrelated later re-export. The binding must sit
    // in one import statement that itself closes on 'usabl/vite'.
    const crossStatement = `import { usablVitePluginFromConfig } from './fake'
export * from 'usabl/vite'
export default {
  plugins: [usablVitePluginFromConfig()],
}
`;
    expect(isOverlayWired(crossStatement)).toBe(false);
  });

  it('planOverlay returns already-wired for a multi-line import config', async () => {
    const multiLine = `import { defineConfig } from 'vite'
import {
  usablVitePluginFromConfig,
} from 'usabl/vite'
export default defineConfig({
  plugins: [
    usablVitePluginFromConfig({ cwd: import.meta.dirname }),
  ],
})
`;
    const plan = await planOverlay(memoryFs({ 'vite.config.ts': multiLine }));
    expect(plan.action).toBe('already-wired');
  });
});

// The patternfly-react-seed layout: three webpack configs, Vite present only for Vitest, and no
// Vite config at all. Writing vite.config.ts here produced a file nothing reads.
const SEED_PACKAGE = JSON.stringify({
  scripts: {
    build: 'webpack --config webpack.prod.js',
    'start:dev': 'webpack serve --color --progress --config webpack.dev.js',
    test: 'vitest run',
    'bundle-profile:analyze': 'npm run build:bundle-profile && webpack-bundle-analyzer ./stats.json',
  },
  devDependencies: { vite: '^6.4.1', vitest: '^4.0.5', webpack: '^5.97.0' },
});
const SEED_FILES = {
  'package.json': SEED_PACKAGE,
  'webpack.common.js': "const path = require('path');\nmodule.exports = (env) => ({ plugins: [] });\n",
  'webpack.dev.js':
    "const { merge } = require('webpack-merge');\nconst common = require('./webpack.common.js');\nmodule.exports = merge(common('development'), { mode: 'development', devServer: {} });\n",
  'webpack.prod.js':
    "const { merge } = require('webpack-merge');\nconst common = require('./webpack.common.js');\nmodule.exports = merge(common('production'), { mode: 'production' });\n",
  'vitest.config.ts': "import { defineConfig } from 'vitest/config'\nexport default defineConfig({})\n",
};

const WIRED_WEBPACK_DEV = `const { merge } = require('webpack-merge');
const { UsablWebpackPlugin } = require('usabl/webpack');
const common = require('./webpack.common.js');
module.exports = merge(common('development'), {
  mode: 'development',
  plugins: [new UsablWebpackPlugin({ cwd: __dirname })],
});
`;

describe('planOverlay picks the bundler the app uses', () => {
  it('detects webpack in the seed layout and refuses with the lines for its dev config', async () => {
    const fs = memoryFs(SEED_FILES);
    const plan = await planOverlay(fs);
    expect(plan).toMatchObject({ action: 'refuse', bundler: 'webpack', path: 'webpack.dev.js' });

    const result = await writeOverlay(fs, plan);
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(result.message).toContain("const { UsablWebpackPlugin } = require('usabl/webpack')");
    expect(result.message).toContain('new UsablWebpackPlugin({ cwd: __dirname }),');
    expect(result.message).toContain('webpack.dev.js');
    // Nothing is written, and above all no Vite config that nothing would read.
    expect(Object.keys(fs.store).sort()).toEqual(Object.keys(SEED_FILES).sort());
    expect(fs.store['vite.config.ts']).toBeUndefined();
  });

  it('reports a wired webpack dev config as already wired', async () => {
    const fs = memoryFs({ ...SEED_FILES, 'webpack.dev.js': WIRED_WEBPACK_DEV });
    const plan = await planOverlay(fs);
    expect(plan).toMatchObject({ action: 'already-wired', bundler: 'webpack', path: 'webpack.dev.js' });
  });

  it('does not count a commented-out webpack plugin as wiring', async () => {
    const commented = WIRED_WEBPACK_DEV.replace('plugins: [new', '// plugins: [new');
    const plan = await planOverlay(memoryFs({ ...SEED_FILES, 'webpack.dev.js': commented }));
    expect(plan.action).toBe('refuse');
  });

  it('hands over import lines for an ES module webpack config', async () => {
    const fs = memoryFs({ 'webpack.config.mjs': 'export default { mode: "development" };\n' });
    const result = await writeOverlay(fs, await planOverlay(fs));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("import { UsablWebpackPlugin } from 'usabl/webpack'");
    expect(result.message).toContain('new UsablWebpackPlugin({ cwd: import.meta.dirname }),');
  });

  it('finds a webpack config named by a script outside the repository root', async () => {
    const fs = memoryFs({
      'package.json': JSON.stringify({ scripts: { start: 'webpack serve --config config/webpack.dev.cjs' } }),
      'config/webpack.dev.cjs': 'module.exports = { mode: "development" };\n',
    });
    const plan = await planOverlay(fs);
    expect(plan).toMatchObject({ action: 'refuse', bundler: 'webpack', path: 'config/webpack.dev.cjs' });
    const result = await writeOverlay(fs, plan);
    // The config is one folder down, so the app root is its parent.
    expect(result.message).toContain("cwd: require('node:path').resolve(__dirname, '..')");
  });

  it('refuses and names every file it saw when it finds both Vite and webpack', async () => {
    const fs = memoryFs({
      'vite.config.ts': "import { defineConfig } from 'vite'\nexport default defineConfig({})\n",
      'webpack.config.js': 'module.exports = {};\n',
    });
    const plan = await planOverlay(fs);
    expect(plan.action).toBe('undetected');
    const result = await writeOverlay(fs, plan);
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('refused');
    expect(result.message).toContain('vite.config.ts');
    expect(result.message).toContain('webpack.config.js');
    expect(Object.keys(fs.store).sort()).toEqual(['vite.config.ts', 'webpack.config.js']);
  });

  it('refuses and says what it looked for when it finds neither', async () => {
    const fs = memoryFs({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    const plan = await planOverlay(fs);
    expect(plan.action).toBe('undetected');
    const result = await writeOverlay(fs, plan);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('vite.config.ts');
    expect(result.message).toContain('webpack.config.js');
    expect(fs.store['vite.config.ts']).toBeUndefined();
  });

  it('writes vite.config.ts when a script runs Vite and no config exists, because Vite reads it', async () => {
    const fs = memoryFs({ 'package.json': JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }) });
    const plan = await planOverlay(fs);
    expect(plan).toMatchObject({ action: 'write', bundler: 'vite', path: 'vite.config.ts' });
    const result = await writeOverlay(fs, plan);
    expect(result.exitCode).toBe(0);
    expect(fs.store['vite.config.ts']).toBe(OVERLAY_DRAFT);
  });

  it('does not take vite-node or vitest for Vite', async () => {
    const fs = memoryFs({
      'package.json': JSON.stringify({ scripts: { a: 'vite-node scripts/x.ts', b: 'vitest run' } }),
    });
    expect((await planOverlay(fs)).action).toBe('undetected');
  });
});
