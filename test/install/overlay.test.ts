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

describe('planOverlay', () => {
  it('plans a full draft when no vite config exists', async () => {
    const plan = await planOverlay(memoryFs({}));
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
});

describe('writeOverlay', () => {
  it('writes the draft when absent and stays idempotent on a second run', async () => {
    const fs = memoryFs({});
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
});

describe('isOverlayWired', () => {
  it('requires both the import and the plugin call', () => {
    expect(isOverlayWired(OVERLAY_DRAFT)).toBe(true);
    expect(isOverlayWired("import { usablVitePluginFromConfig } from 'usabl/vite'\n")).toBe(false);
    expect(isOverlayWired('usablVitePluginFromConfig({ cwd: import.meta.dirname })\n')).toBe(false);
  });
});
