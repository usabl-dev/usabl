/**
 * The voice contract transcript in real Chromium. Deleting a row moves focus to the undo control
 * and writes "Row deleted" into a polite region, either 400 ms later or at once. The runner waits
 * for the page to settle after the step, so both variants are heard, and two runs on fresh pages
 * give the same transcript. Before the settle wait, the late variant drained before the update
 * landed and the window held no live token.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserDriver, InteractionContract, TranscriptStop } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { runStructuralTier } from '../../src/voicing/structural.js';
import { runVoicingTier } from '../../src/voicing/voicing.js';

const CONTRACT: InteractionContract = {
  contractId: 'delete-row-announces',
  surfaceId: 'rows',
  task: 'Deleting a row announces the deletion',
  steps: [{ do: 'click', selector: '[data-row="a"] button[aria-label="Delete"]' }],
  obligations: [
    { class: 'focus-name', afterStep: 0, requiredTokens: ['undo delete'], focusedRole: 'button', mustAnnounce: false },
    { class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true },
  ],
};

// Each run opens a fresh page, waits for it to load, and waits up to the settle cap after the step.
// The budget is set well above that, so machine load cannot decide the outcome.
const BROWSER_BUDGET_MS = 60_000;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('a voice contract transcript in Chromium', { timeout: BROWSER_BUDGET_MS }, () => {
  let server: Server;
  let baseUrl: string;
  let driver: BrowserDriver;

  beforeAll(async () => {
    const html = await readFile(fileURLToPath(new URL('../../fixtures/live/voice-delete-row.html', import.meta.url)), 'utf8');
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}/voice-delete-row.html`;
    driver = makeRealBrowserDriver();
  });

  afterAll(async () => {
    await driver.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  async function transcript(delayMs: number): Promise<TranscriptStop[]> {
    const page = await driver.open(`${baseUrl}?delay=${delayMs}`);
    try {
      await page.gotoReady();
      return await makeStepRunner({ settleAfterEachStep: true }).run(page, CONTRACT.steps);
    } finally {
      await page.close();
    }
  }

  function liveTexts(stops: TranscriptStop[]): Array<string | null> {
    return stops.flatMap((stop) => stop.announcement.filter((token) => token.kind === 'live').map((token) => token.text));
  }

  it.each([
    ['400 ms after the click', 400],
    ['at the click', 0],
  ])('hears an announcement made %s, the same way on two fresh pages', async (_label, delayMs) => {
    const first = await transcript(delayMs);
    const second = await transcript(delayMs);

    expect(second).toEqual(first);
    for (const stops of [first, second]) {
      expect(stops).toHaveLength(1);
      expect(stops[0]?.unsettled).toBeUndefined();
      expect(stops[0]?.drainUndecidable).toBeUndefined();
      expect(liveTexts(stops)).toEqual(['Row deleted']);
      expect(
        stops[0]?.announcement.filter((token) => token.kind === 'name' || token.kind === 'role').map((token) => [token.kind, token.text]),
      ).toEqual([
        ['name', 'Undo delete'],
        ['role', 'button'],
      ]);
      // Both obligations hold, so neither tier reports anything.
      expect([...runStructuralTier(CONTRACT, stops, 'rows'), ...runVoicingTier(CONTRACT, stops, 'rows')]).toEqual([]);
    }
  });
});
