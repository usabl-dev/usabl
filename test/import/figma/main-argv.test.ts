/**
 * The main CLI hands the import command every argument except the command word itself, found by
 * where the parser read it. A flag value that is also the word "import" stays where it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runImportCommand = vi.fn(async (_args: readonly string[]) => ({ exitCode: 0, stdout: '', stderr: '' }));
vi.mock('../../../src/import/figma/cli.js', () => ({ runImportCommand }));

const { main } = await import('../../../src/cli.js');

describe('usabl import argument hand-off', () => {
  beforeEach(() => {
    runImportCommand.mockClear();
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses --config before the import command, so the import never runs', async () => {
    // The import takes no config. The flag check answers before any command runs.
    expect(await main(['--config', 'import', 'import', 'figma', 'K', '--frame', 'A=a', '--out', 'x'])).toBe(2);
    expect(runImportCommand).not.toHaveBeenCalled();
  });

  it.each([
    [
      ['--owner', 'import', '--min-target', '24', 'import', 'figma', 'K', '--frame', 'A=a', '--out', 'x'],
      ['--owner', 'import', '--min-target', '24', 'figma', 'K', '--frame', 'A=a', '--out', 'x'],
    ],
    [
      ['--owner', 'import', 'import', 'figma', 'K', '--frame', 'A=a', '--out', 'x'],
      ['--owner', 'import', 'figma', 'K', '--frame', 'A=a', '--out', 'x'],
    ],
    [
      ['import', 'figma', 'K', '--frame', 'import=a', '--out', 'x'],
      ['figma', 'K', '--frame', 'import=a', '--out', 'x'],
    ],
  ])('removes the command word by its parsed position: %j', async (argv, handed) => {
    await main(argv);
    expect(runImportCommand).toHaveBeenCalledTimes(1);
    expect(runImportCommand.mock.calls[0]?.[0]).toEqual(handed);
  });
});
