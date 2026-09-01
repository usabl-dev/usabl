/**
 * These tests exercise the glue, not just the generators. They run main() end to end
 * against a real temporary working directory, proving that each install target is routed
 * to the right generator, that the real install filesystem creates parent folders and
 * writes the expected file, and that install runs before the check-path ciRefusal so
 * `install --ci` wires the workflow instead of demanding --trusted-ref. A mis-route would
 * leave the expected file missing and fail these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import {
  USABL_DOCS_GATE_WORKFLOW,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { CLAUDE_SETTINGS_PATH } from '../../src/install/claude.js';
import { CLAUDE_SKILL_CONTENTS, CLAUDE_SKILL_PATH } from '../../src/install/claude-skill.js';

describe('usabl install command wiring', () => {
  let workspace: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-install-main-'));
    // The install filesystem resolves relative paths against the process cwd, so run inside
    // a throwaway directory and keep report output from cluttering the test log.
    process.chdir(workspace);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  });

  it('routes --overlay to the overlay generator and writes vite.config.ts', async () => {
    const code = await main(['install', '--overlay']);
    expect(code).toBe(0);
    const written = await readFile(join(workspace, 'vite.config.ts'), 'utf8');
    expect(written).toContain("import { usablVitePluginFromConfig } from 'usabl/vite'");
    expect(written).toContain('usablVitePluginFromConfig({ cwd: import.meta.dirname })');
  });

  it('routes --claude to the claude generator and writes .claude/settings.json', async () => {
    const code = await main(['install', '--claude']);
    expect(code).toBe(0);
    // The nested .claude folder must be created by the install filesystem before the write.
    const written = await readFile(join(workspace, CLAUDE_SETTINGS_PATH), 'utf8');
    expect(written).toContain('npx usabl stop-hook');
  });

  it('routes --claude-skill to the claude-skill generator and writes the usabl-check skill file', async () => {
    // The nested .claude/skills/usabl-check folders must be created by the install filesystem
    // before the write. A mis-route to the Stop-hook generator would leave this file missing.
    const code = await main(['install', '--claude-skill']);
    expect(code).toBe(0);
    const written = await readFile(join(workspace, CLAUDE_SKILL_PATH), 'utf8');
    expect(written).toBe(CLAUDE_SKILL_CONTENTS);
    // --claude-skill wires the on-demand command only; it must not also write settings.json.
    await expect(readFile(join(workspace, CLAUDE_SETTINGS_PATH), 'utf8')).rejects.toThrow();
  });

  it('routes --ci to the ci generator and writes the gate workflow, not a --trusted-ref refusal', async () => {
    // Locks the ordering: install runs before the check-path ciRefusal, so --ci here means
    // the install target and never "CI mode requires --trusted-ref". The nested
    // .github/workflows folder must also be created before the write.
    const code = await main(['install', '--ci']);
    expect(code).toBe(0);
    const written = await readFile(join(workspace, USABL_GATE_WORKFLOW_PATH), 'utf8');
    expect(written).toBe(USABL_GATE_WORKFLOW);
  });

  it('routes --docs-ci to the docs-ci generator and writes the docs gate workflow', async () => {
    // The docs target is distinct from --ci: it must land on the docs gate file with the
    // docs template verbatim, never the app gate. A mis-route would write the wrong workflow.
    const code = await main(['install', '--docs-ci']);
    expect(code).toBe(0);
    const written = await readFile(join(workspace, USABL_DOCS_GATE_WORKFLOW_PATH), 'utf8');
    expect(written).toBe(USABL_DOCS_GATE_WORKFLOW);
    // And it must not also write the app gate.
    await expect(readFile(join(workspace, USABL_GATE_WORKFLOW_PATH), 'utf8')).rejects.toThrow();
  });

  it('init --docs cleanly reports no supported docs format and writes nothing', async () => {
    // An empty workspace has no docs format, which is a clean no-op (exit 0), not a failure.
    const code = await main(['init', '--docs']);
    expect(code).toBe(0);
    await expect(readFile(join(workspace, 'usabl.docs.json'), 'utf8')).rejects.toThrow();
  });

  it('routes init --docs to the docs generator for an AsciiBinder repo and drafts usabl.docs.json', async () => {
    // A minimal AsciiBinder repo: one topic map with a single leaf topic and its source .adoc.
    await mkdir(join(workspace, '_topic_maps'), { recursive: true });
    await writeFile(
      join(workspace, '_topic_maps', '_topic_map.yml'),
      'Name: Install Guide\nDir: install\nTopics:\n  - Name: Overview\n    File: overview\n',
      'utf8',
    );
    await mkdir(join(workspace, 'install'), { recursive: true });
    await writeFile(join(workspace, 'install', 'overview.adoc'), '= Overview\n\nSome text.\n', 'utf8');

    const code = await main(['init', '--docs']);
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(join(workspace, 'usabl.docs.json'), 'utf8')) as {
      format: string;
      pages: Array<{ assemblyFile: string }>;
    };
    expect(written.format).toBe('asciibinder');
    expect(written.pages).toHaveLength(1);
    expect(written.pages[0]?.assemblyFile).toBe('install/overview.adoc');
    // init --docs is docs-only onboarding: it must not also draft an app usabl.config.json.
    await expect(readFile(join(workspace, 'usabl.config.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses with exit 2 when no install target flag is given', async () => {
    const code = await main(['install']);
    expect(code).toBe(2);
  });
});
