/**
 * usabl doctor reports a Stop hook whose time limit usabl cannot plan to: one with no timeout, one
 * below the runner's minimum, and one whose command and timeout disagree. A hook the assistant ends
 * at its limit lets the stop go on with nothing checked, so such a hook is never reported wired.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { GhReader } from '../../src/install/branch-rule.js';
import { CLAUDE_SETTINGS_PATH, PREVIOUS_STOP_HOOK_COMMAND, STOP_HOOK_COMMAND, stopHookCommand } from '../../src/install/claude.js';
import {
  CURSOR_COMMAND_CONTENTS,
  CURSOR_COMMAND_PATH,
  CURSOR_HOOKS_JSON_PATH,
  CURSOR_RULE_CONTENTS,
  CURSOR_RULE_PATH,
  CURSOR_STOP_SCRIPT,
  CURSOR_STOP_SCRIPT_PATH,
} from '../../src/install/cursor.js';
import { collectDoctorReport, type DoctorDeps, type SurfaceReport } from '../../src/doctor/index.js';

// gh could not run, so the branch rule reads as unknown. This file does not look at it.
const GH_UNAVAILABLE: GhReader = { getJson: async () => null };

function readOnlyFs(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async (patterns) => Object.keys(files).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

async function report(files: Record<string, string>, id: string): Promise<SurfaceReport> {
  const deps: DoctorDeps = {
    fs: readOnlyFs(files),
    gh: GH_UNAVAILABLE,
    configPath: 'usabl.config.json',
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
    env: {},
  };
  const found = (await collectDoctorReport(deps)).find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`no surface report with id ${id}`);
  }
  return found;
}

function claudeSettings(hook: Record<string, unknown>): Record<string, string> {
  return { [CLAUDE_SETTINGS_PATH]: `${JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }, null, 2)}\n` };
}

describe('doctor and the Claude Code Stop hook time limit', () => {
  it('reports the hook usabl writes as wired', async () => {
    const stop = await report(claudeSettings({ type: 'command', command: STOP_HOOK_COMMAND, timeout: 600 }), 'stop-hook');
    expect(stop.state).toBe('wired');
  });

  it('reports a hook with no timeout as drifted, and says what that costs and how to fix it', async () => {
    const stop = await report(claudeSettings({ type: 'command', command: PREVIOUS_STOP_HOOK_COMMAND }), 'stop-hook');
    expect(stop.state).toBe('drifted');
    expect(stop.nextStep).toContain('sets no timeout');
    expect(stop.nextStep).toContain('the stop goes on with nothing checked');
    expect(stop.nextStep).toContain('usabl install --claude');
  });

  it('reports a limit below the minimum as drifted', async () => {
    const stop = await report(claudeSettings({ type: 'command', command: stopHookCommand(30), timeout: 30 }), 'stop-hook');
    expect(stop.state).toBe('drifted');
    expect(stop.nextStep).toContain('below 60 seconds');
    expect(stop.nextStep).toContain('usabl install --claude');
  });

  it('reports a timeout that does not match the command as drifted', async () => {
    const stop = await report(claudeSettings({ type: 'command', command: STOP_HOOK_COMMAND, timeout: 300 }), 'stop-hook');
    expect(stop.state).toBe('drifted');
    expect(stop.nextStep).toContain('does not match USABL_STOP_HOOK_TIMEOUT');
  });

  it('reports a timeout on a command that sets no limit, and says the command sets none', async () => {
    const stop = await report(claudeSettings({ type: 'command', command: PREVIOUS_STOP_HOOK_COMMAND, timeout: 600 }), 'stop-hook');
    expect(stop.state).toBe('drifted');
    expect(stop.nextStep).toContain('or the command sets none');
    // The runner then plans to the shortest Claude Code default, so it stops checking early.
    expect(stop.nextStep).toContain('60 seconds');
  });
});

describe('doctor and the Cursor stop hook time limit', () => {
  const others = {
    [CURSOR_STOP_SCRIPT_PATH]: CURSOR_STOP_SCRIPT,
    [CURSOR_COMMAND_PATH]: CURSOR_COMMAND_CONTENTS,
    [CURSOR_RULE_PATH]: CURSOR_RULE_CONTENTS,
  };

  function hooksJson(entry: Record<string, unknown>): Record<string, string> {
    return { [CURSOR_HOOKS_JSON_PATH]: `${JSON.stringify({ version: 1, hooks: { stop: [entry] } }, null, 2)}\n` };
  }

  it('reports a usabl stop entry with no timeout as drifted', async () => {
    const cursor = await report({ ...others, ...hooksJson({ command: '.cursor/hooks/usabl-stop.sh', loop_limit: 3 }) }, 'cursor');
    expect(cursor.state).toBe('drifted');
    expect(cursor.nextStep).toContain('sets no timeout');
    expect(cursor.nextStep).toContain('usabl install --cursor');
  });

  it('reports a usabl stop entry below 300 seconds as drifted', async () => {
    const cursor = await report(
      { ...others, ...hooksJson({ command: '.cursor/hooks/usabl-stop.sh', timeout: 120, loop_limit: 3 }) },
      'cursor',
    );
    expect(cursor.state).toBe('drifted');
    expect(cursor.nextStep).toContain('below 300 seconds');
  });
});
