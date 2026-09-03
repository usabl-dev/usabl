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

describe('usabl stop-hook command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads stdin, delegates to the runner, and always exits 0', async () => {
    const restore = withStdin('{invalid-json}');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['stop-hook']);
      expect(code).toBe(0);
      const written = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain('NOT verified - invalid stop hook input JSON');
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
      expect(stderrText).toContain('NOT verified');
    } finally {
      restore();
    }
  });
});
