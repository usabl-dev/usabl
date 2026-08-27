import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/stage-public-pages.mjs');

describe('stage-public-pages command', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('stages only the approved public pages', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-pages-test-'));
    const source = join(root, 'docs');
    const output = join(root, 'site');
    await mkdir(source);
    await writeFile(join(source, 'team-orientation.html'), 'orientation\n', 'utf8');
    await writeFile(join(source, 'how-usabl-works.html'), 'how\n', 'utf8');
    await writeFile(join(source, 'code-walkthrough.html'), 'walkthrough\n', 'utf8');
    await writeFile(join(source, 'threat-model.md'), 'not public\n', 'utf8');

    await expect(
      execFileAsync(process.execPath, [scriptPath, source, output], { encoding: 'utf8' }),
    ).resolves.toMatchObject({
      stdout: 'Staged public Pages files: code-walkthrough.html, how-usabl-works.html, index.html, team-orientation.html\n',
    });
    await expect(readdir(output)).resolves.not.toContain('threat-model.md');
    await expect(readFile(join(output, 'index.html'), 'utf8')).resolves.toBe('orientation\n');
  });
});
