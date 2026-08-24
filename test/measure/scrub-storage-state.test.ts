import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubStorageStateDocument, scrubStorageStateFile } from '../../scripts/scrub-storage-state.js';

describe('scrub-storage-state', () => {
  it('scrubs credential-shaped cookies and drops origin storage from review output', () => {
    const source = {
      cookies: [
        { name: 'session', value: 'abc123' },
        { name: 'locale', value: 'en-US' },
        { name: 'csrf', value: '12345678901234567890' },
      ],
      origins: [
        {
          origin: 'https://fleet.example.test',
          localStorage: [
            { name: 'access_token', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' },
            { name: 'theme', value: 'dark' },
          ],
        },
      ],
    };

    const result = scrubStorageStateDocument(source);
    expect(result.totalCookies).toBe(3);
    expect(result.scrubbedCookies).toBe(2);
    expect(result.scrubbed.cookies).toEqual([
      { name: 'session', value: '[SCRUBBED:session]' },
      { name: 'locale', value: 'en-US' },
      { name: 'csrf', value: '[SCRUBBED:csrf]' },
    ]);
    expect(result.scrubbed.origins).toBeUndefined();
  });

  it('writes a .scrubbed.json sibling file and reports counts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'usabl-scrub-'));
    const inputPath = join(tempDir, 'storageState.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        cookies: [{ name: 'sso', value: 'THISISALONGTOKENVALUE_12345' }],
        origins: [],
      }),
      'utf8',
    );

    try {
      const result = await scrubStorageStateFile(inputPath);
      expect(result.totalCookies).toBe(1);
      expect(result.scrubbedCookies).toBe(1);
      expect(result.outputPath).toBe(join(tempDir, 'storageState.scrubbed.json'));

      const scrubbed = JSON.parse(await readFile(result.outputPath, 'utf8')) as {
        cookies: Array<{ value: string }>;
        origins?: unknown;
      };
      expect(scrubbed.cookies[0]?.value).toBe('[SCRUBBED:sso]');
      expect(scrubbed.origins).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
