/**
 * These tests exercise the glue, not just the generators. They run main() end to end
 * against a real temporary working directory, proving that each install target is routed
 * to the right generator, that the real install filesystem creates parent folders and
 * writes the expected file, and that install runs before the check-path ciRefusal so
 * `install --ci` wires the workflow instead of demanding --trusted-ref. A mis-route would
 * leave the expected file missing and fail these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { USABL_GATE_WORKFLOW, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { CLAUDE_SETTINGS_PATH } from '../../src/install/claude.js';

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

  it('routes --ci to the ci generator and writes the gate workflow, not a --trusted-ref refusal', async () => {
    // Locks the ordering: install runs before the check-path ciRefusal, so --ci here means
    // the install target and never "CI mode requires --trusted-ref". The nested
    // .github/workflows folder must also be created before the write.
    const code = await main(['install', '--ci']);
    expect(code).toBe(0);
    const written = await readFile(join(workspace, USABL_GATE_WORKFLOW_PATH), 'utf8');
    expect(written).toBe(USABL_GATE_WORKFLOW);
  });

  it('refuses with exit 2 when no install target flag is given', async () => {
    const code = await main(['install']);
    expect(code).toBe(2);
  });
});
