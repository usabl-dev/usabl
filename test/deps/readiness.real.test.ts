/**
 * Real Chromium validation for the readiness fix. Gated behind USABL_INTEGRATION=1 like the other
 * browser tests, because it launches Chromium.
 *
 * The unit tests drive a fake network signal. This file proves the fake matches the browser on the
 * one fact everything else rests on: a request that starts after the page first goes idle, and
 * mounts content when it returns, must be waited for. That is the exact case Playwright's
 * waitForLoadState('networkidle') misses, because it is one-shot per navigation.
 *
 * It serves a page that mounts a small DOM immediately, then, only after the load event, fires a
 * slow fetch that mounts the rest when it returns. A readiness function that trusted networkidle
 * would return on the small DOM. This one has to return on the full page.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRealBrowserDriver } from '../../src/deps/real.js';

const LATE_FETCH_DELAY_MS = 800; // starts after load, past the networkidle quiet window
const FETCH_DURATION_MS = 2_000;

const LATE_BUTTON_COUNT = 40;

// The page fires a slow fetch only after the load event, then mounts one button per returned count
// using createElement, never innerHTML. The count comes back as plain text, so nothing page-derived
// is ever parsed as markup.
const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <main id="root"><p>initial</p></main>
    <script>
      window.addEventListener('load', function () {
        setTimeout(function () {
          fetch('/late').then(function (r) { return r.text(); }).then(function (text) {
            var count = parseInt(text, 10);
            var root = document.getElementById('root');
            root.textContent = '';
            for (var i = 0; i < count; i += 1) {
              var button = document.createElement('button');
              button.textContent = 'action ' + i;
              root.appendChild(button);
            }
          });
        }, ${LATE_FETCH_DELAY_MS});
      });
    </script>
  </body>
</html>`;

// Two requests are in flight at once, so the count reaches two. The fast one returns a full quiet
// window before the slow one, and only the slow one mounts the content. A tracker that drops an
// increment or decrements twice for one settle reads the count as zero when the fast request
// returns, while the slow request is still out, so readiness returns on the pre-mount DOM. A
// single-request test cannot expose that, because with one request the count only swings between
// zero and one, so an off-by-one never crosses into premature idle.
const FAST_FETCH_DURATION_MS = 1_000;
const SLOW_FETCH_DURATION_MS = 3_000; // returns two seconds after the fast one, well past the window
const CONCURRENT_BUTTON_COUNT = 25;

const CONCURRENT_HTML = `<!doctype html>
<html>
  <body>
    <main id="root"><p>initial</p></main>
    <script>
      window.addEventListener('load', function () {
        setTimeout(function () {
          // Fast request: returns early, mounts nothing. It only occupies a second slot in the count.
          fetch('/fast').then(function (r) { return r.text(); });
          // Slow request: returns later and mounts the real content.
          fetch('/slow').then(function (r) { return r.text(); }).then(function (text) {
            var count = parseInt(text, 10);
            var root = document.getElementById('root');
            root.textContent = '';
            for (var i = 0; i < count; i += 1) {
              var button = document.createElement('button');
              button.textContent = 'action ' + i;
              root.appendChild(button);
            }
          });
        }, ${LATE_FETCH_DELAY_MS});
      });
    </script>
  </body>
</html>`;

interface Fixture {
  singleUrl: string;
  concurrentUrl: string;
  close: () => Promise<void>;
}

function makeServer(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/late') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(LATE_BUTTON_COUNT));
      }, FETCH_DURATION_MS);
      return;
    }
    if (req.url === '/fast') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, FAST_FETCH_DURATION_MS);
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(CONCURRENT_BUTTON_COUNT));
      }, SLOW_FETCH_DURATION_MS);
      return;
    }
    if (req.url === '/concurrent') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(CONCURRENT_HTML);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        singleUrl: `${base}/`,
        concurrentUrl: `${base}/concurrent`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('waitForRendered against real Chromium', () => {
  let fixture: Fixture;
  const driver = makeRealBrowserDriver();

  beforeAll(async () => {
    fixture = await makeServer();
  });

  afterAll(async () => {
    await driver.close();
    await fixture.close();
  });

  // An explicit budget well above the real work. Healthy readiness waits about 5s here, which is
  // right at vitest's 5000ms default, so the default cannot tell healthy code from a tracker that
  // never reaches idle: both land near or past 5000ms. With a 30000ms budget, healthy code passes
  // in about 5s and a broken tracker hangs to the readiness budget and fails on the assertions
  // rather than on the test runner. 30000ms matches the real-browser convention in
  // pf6-real-markup.test.ts.
  it('waits for a post-load fetch that networkidle would miss', async () => {
    const started = Date.now();
    const page = await driver.open(fixture.singleUrl);
    await page.gotoReady();
    const waited = Date.now() - started;

    // The full page mounted, not the initial one. This is the assertion that fails if readiness
    // returned on the small DOM while the fetch was still out.
    const buttons = await page.queryAll('button');
    expect(buttons.length).toBe(LATE_BUTTON_COUNT);

    // It genuinely waited for the fetch, so the time cannot be near zero. The fetch alone is
    // LATE_FETCH_DELAY_MS + FETCH_DURATION_MS after load.
    expect(waited).toBeGreaterThanOrEqual(LATE_FETCH_DELAY_MS + FETCH_DURATION_MS);

    await page.close();
  }, 30_000);

  // Two concurrent late fetches, so the in-flight count reaches two. The single-fetch test above
  // catches a tracker that never reaches idle, because it hangs, but not an accounting imbalance: a
  // dropped increment or a double-decrement leaves the count at zero when the fast request returns
  // while the slow one is still out, so readiness returns on the pre-mount DOM. Only the slow
  // request mounts the content, so the button assertion is what has teeth against that.
  it('waits for the slower of two concurrent late fetches', async () => {
    const started = Date.now();
    const page = await driver.open(fixture.concurrentUrl);
    await page.gotoReady();
    const waited = Date.now() - started;

    // The slow request mounts the content. An off-by-one in the counter returns early on the empty
    // shell, so this reads zero buttons.
    const buttons = await page.queryAll('button');
    expect(buttons.length).toBe(CONCURRENT_BUTTON_COUNT);

    // Readiness held until the slow request, not just the fast one. The fast request clears at
    // LATE_FETCH_DELAY_MS + FAST_FETCH_DURATION_MS; returning then would be well short of this bound.
    expect(waited).toBeGreaterThanOrEqual(LATE_FETCH_DELAY_MS + SLOW_FETCH_DURATION_MS);

    await page.close();
  }, 30_000);
});
