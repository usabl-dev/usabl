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
