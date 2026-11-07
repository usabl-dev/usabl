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
    return transcriptAt(`delay=${delayMs}`, CONTRACT);
  }

  async function transcriptAt(query: string, contract: InteractionContract): Promise<TranscriptStop[]> {
    const page = await driver.open(`${baseUrl}?${query}`);
    try {
      await page.gotoReady();
      return await makeStepRunner({ settleAfterEachStep: true }).run(page, contract.steps);
    } finally {
      await page.close();
    }
  }

  function drafts(contract: InteractionContract, stops: TranscriptStop[]) {
    return [...runStructuralTier(contract, stops, 'rows'), ...runVoicingTier(contract, stops, 'rows')];
  }

  function liveTexts(stops: TranscriptStop[]): Array<string | null> {
    return stops.flatMap((stop) => stop.announcement.filter((token) => token.kind === 'live').map((token) => token.text));
  }

  it.each([
    ['400 ms after the click', 400],
    ['at the click', 0],
    // Text only: no element is added and no request is sent, so only the live record sees it.
    ['1600 ms after the click, as text only', 1600],
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

  it('judges a window where the row is removed when a slow request answers, 1200 ms after the click', async () => {
    const stops = await transcriptAt('remove=1200', CONTRACT);

    expect(stops[0]?.unsettled).toBeUndefined();
    expect(liveTexts(stops)).toEqual(['Row deleted']);
    expect(drafts(CONTRACT, stops)).toEqual([]);
  });

  it('credits a late announcement to the step that caused it, not to the next step', async () => {
    const twoSteps: InteractionContract = {
      ...CONTRACT,
      steps: [...CONTRACT.steps, { do: 'tab' }],
      obligations: [
        { class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true },
        { class: 'focus-name', afterStep: 1, requiredTokens: ['close'], focusedRole: 'button', mustAnnounce: false },
      ],
    };

    const stops = await transcriptAt('delay=1600', twoSteps);

    expect(stops.map((stop) => stop.announcement.filter((token) => token.kind === 'live').map((token) => token.text))).toEqual([
      ['Row deleted'],
      [],
    ]);
    expect(drafts(twoSteps, stops)).toEqual([]);
  });

  it('turns a window on a page that never settles into an undecided gap, never a miss', async () => {
    const stops = await transcriptAt('churn=1', CONTRACT);
    const found = drafts(CONTRACT, stops);

    expect(stops[0]?.unsettled).toBeDefined();
    expect(found.map((draft) => [draft.rule, draft.confidence])).toEqual([
      ['voicing/window-undecided', 'unverified'],
      ['voicing/window-undecided', 'unverified'],
    ]);
  });
});
