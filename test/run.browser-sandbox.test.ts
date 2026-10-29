/**
 * What a run says when its scan browser ran without Chromium's sandbox, and what it does when the
 * operator requires the sandbox and the system cannot provide one. The real check runner is in the
 * path, so the page's own report travels the way it does in the CLI.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import type { Deps, Page, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { BrowserSandboxRequiredError } from '../src/deps/sandbox.js';
import { parseResultDocument } from '../src/intake/result-document.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';
import { projectCli } from '../src/surfaces/cli.js';

const SCREEN_URL = 'http://app.test/users';

const config: UsablConfig = {
  appBaseUrl: 'http://app.test',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'users', url: SCREEN_URL, files: ['fixtures/app/src/UsersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const POLICY_FILES = { 'usabl.config.json': '{}' };

function pageFor(sandbox: 'on' | 'off'): Page {
  return {
    ...makeFakePage({
      currentUrl: async () => SCREEN_URL,
      // A real focusable stop, so the screen counts as seen.
      activePath: async () => 'html > body > main > button#save',
      activeNode: async () => ({ name: 'Save', role: 'button', states: {} }),
    }),
    ...(sandbox === 'off' ? { browserSandbox: 'off' as const } : {}),
  };
}

function depsWith(open: () => Promise<Page>): Deps {
  const base = makeFakeDeps({
    files: POLICY_FILES,
    headContents: POLICY_FILES,
    writeTree: 'tree-sandbox',
    changed: [{ code: 'M', path: 'fixtures/app/src/UsersPage.tsx' }],
  });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open, close: async () => {} },
      providers: [],
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
    }),
  };
}

describe('a scan whose browser ran without its sandbox', () => {
  it('carries the note on the screen in the Result and changes no verdict', async () => {
    const sandboxed = await run(depsWith(async () => pageFor('on')), config);
    const unsandboxed = await run(depsWith(async () => pageFor('off')), config);

    expect(unsandboxed.screens.map((screen) => screen.browserSandbox)).toEqual(['off']);
    expect(sandboxed.screens.map((screen) => screen.browserSandbox)).toEqual([undefined]);

    expect(unsandboxed.verdict).toBe(sandboxed.verdict);
    expect(unsandboxed.exitCode).toBe(sandboxed.exitCode);
    expect(unsandboxed.accessibilityVerdict).toBe(sandboxed.accessibilityVerdict);
    expect(unsandboxed.summary).toBe(sandboxed.summary);
  });

  it('says so in a line of the run output, with the way to fix it', async () => {
    const unsandboxed = await run(depsWith(async () => pageFor('off')), config);
    const sandboxed = await run(depsWith(async () => pageFor('on')), config);

    const text = projectCli(unsandboxed).text;
    const line = text.split('\n').find((entry) => entry.includes('browser sandbox'));
    expect(line).toBeDefined();
    expect(line).toContain('without Chromium');
    expect(line).toContain('usabl doctor');
    expect(line).toContain('"require"');
    expect(projectCli(sandboxed).text).not.toContain('browser sandbox');
  });

  it('keeps the note through the JSON that usabl comment and usabl enforce read', async () => {
    const unsandboxed = await run(depsWith(async () => pageFor('off')), config);
    const document = parseResultDocument(JSON.parse(projectCli(unsandboxed).json));
    expect(document.screens.map((screen) => screen.browserSandbox)).toEqual(['off']);
  });
});

describe('a run that requires the sandbox on a system that cannot provide one', () => {
  it('refuses to scan with exit 4 and says how to enable the sandbox', async () => {
    const result = await run(
      depsWith(async () => {
        throw new BrowserSandboxRequiredError();
      }),
      config,
    );

    expect(result.exitCode).toBe(4);
    expect(result.accessibilityExitCode).toBe(4);
    expect(result.verdict).toBeNull();
    expect(result.accessibilityVerdict).toBeNull();
    expect(result.receipt).toBeNull();
    expect(result.summary).toContain('browserSandbox');
    expect(result.summary).toContain('"require"');
    expect(result.summary).toContain('AppArmor');
    expect(result.summary).toContain('usabl doctor');
    // The terminal shows the summary up to 400 characters, so the whole refusal fits.
    expect(projectCli(result).text).toContain('Run "usabl doctor" for details.');
    expect(projectCli(result).exitCode).toBe(4);
  });

  it('still turns an ordinary open failure into a coverage gap, never exit 4', async () => {
    const result = await run(
      depsWith(async () => {
        throw new Error("browserType.launch: Executable doesn't exist at /opt/chrome");
      }),
      config,
    );
    expect(result.exitCode).toBe(3);
    expect(result.coverage.gaps.some((gap) => gap.reason.includes('screen failed to open'))).toBe(true);
  });
});
