/**
 * The stop-hook command is the stable entry point wired into .claude/settings.json
 * and .cursor/hooks.json. It must read stdin, delegate to runStopHookFromStdin, and
 * preserve the always-exit-0 contract so a wedged hook can never block continuation
 * via an exit code. The --cursor flag must switch the output protocol so the Cursor
 * adapter emits followup_message instead of decision: block. This test drives main()
 * end to end with an invalid payload, which short-circuits before any gate or browser
 * work, proving the wiring without a live run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { main } from '../../src/cli.js';

function withStdin(text: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  return () => {
    if (original !== undefined) {
      Object.defineProperty(process, 'stdin', original);
    }
  };
}

// What the hook says when its input is not JSON: what happened, what it means, and what to do.
const INVALID_INPUT_LINE =
  'NOT verified - the stop hook got input it could not read, so the stop went through and nothing was checked on this stop. ' +
  'Next: check the hook command in .claude/settings.json or .cursor/hooks.json, run usabl doctor, ' +
  'and run usabl check before you call this change accessible.';

describe('usabl stop-hook command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads stdin, delegates to the runner, and always exits 0', async () => {
    const restore = withStdin('{invalid-json}');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['stop-hook']);
      expect(code).toBe(0);
      const written = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(written.trim()).toBe(INVALID_INPUT_LINE);
      // Claude Code does not show that stderr on exit 0, so the same line goes out as a systemMessage.
      const stdoutText = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(JSON.parse(stdoutText.trim())).toEqual({ systemMessage: INVALID_INPUT_LINE });
    } finally {
      restore();
    }
  });

  it('forwards --cursor flag so the Cursor adapter emits {} instead of nothing', async () => {
    // Without --cursor forwarding, the Cursor hook would speak Claude's protocol and
    // Cursor would ignore the output. This test proves the flag reaches the runner.
    const restore = withStdin('{invalid-json}');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['stop-hook', '--cursor']);
      expect(code).toBe(0);
      // Cursor mode emits {} on stdout even on error (allow with disclosure).
      const stdoutText = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(stdoutText.trim()).toBe('{}');
      const stderrText = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText.trim()).toBe(INVALID_INPUT_LINE);
    } finally {
      restore();
    }
  });
});
