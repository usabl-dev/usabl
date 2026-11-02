/**
 * Setup for the axe comparison sweep (vitest.axe-sweep.config.ts). It runs the tests that drive a
 * real browser, and every time a test runs axe it runs axe the other way too, on the same page at
 * the same moment, and records how the two compare. A test that runs axe in the isolated world
 * gets a page-world run beside it, and a test that runs axe in the page world through
 * @axe-core/playwright gets an isolated run beside it. What the test itself receives is unchanged.
 *
 * Each comparison is appended as one JSON line to the file USABL_AXE_SWEEP_LOG names. Page
 * addresses are reduced to their path, so no port or query string is recorded.
 *
 * Test-only. Nothing here ships in the package.
 */
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { AxeBuilder } from '@axe-core/playwright';
import type { CDPSession, Page as PwPage } from 'playwright';
import type * as AxeWorld from '../../src/deps/axe-world.js';
import { compareRaw, pageWorldRaw, runOptionsFor, tagsOf } from './axe-worlds.js';

const LOG = process.env.USABL_AXE_SWEEP_LOG ?? '';
// Some tests change the working directory, so paths are made relative to the repository root.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// One comparison at a time, and none inside another: the comparison's own axe runs must not be
// compared again.
let comparing = false;

function where(pw: PwPage): string {
  const url = pw.url();
  if (url.startsWith('data:')) {
    return `data URL ${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? `file ${parsed.pathname.split('/').slice(-2).join('/')}` : parsed.pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
}

function record(entry: Record<string, unknown>): void {
  if (LOG === '') return;
  const state = expect.getState();
  const file = state.testPath === undefined ? '' : relative(ROOT, state.testPath);
  appendFileSync(LOG, `${JSON.stringify({ file, test: state.currentTestName ?? '', ...entry })}\n`);
}

async function compareAndRecord(
  via: string,
  pw: PwPage,
  pageRaw: unknown,
  isolated: { results: unknown; uncheckedFrames: AxeWorld.UncheckedFrame[] },
  tags: string[] | undefined,
): Promise<void> {
  try {
    const result = await compareRaw(pw, pageRaw, isolated, tags === undefined ? {} : { tags });
    record({
      via,
      page: where(pw),
      counts: result.counts,
      differences: result.differences,
      uncheckedFrames: result.isolated.uncheckedFrames,
      unstable: result.unstable,
    });
  } catch (error) {
    // The page closed, or navigated, before the comparison finished. Recorded, never hidden.
    record({ via, page: where(pw), error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
  }
}

vi.mock('../../src/deps/axe-world.js', async (importOriginal) => {
  const original = await importOriginal<typeof AxeWorld>();
  return {
    ...original,
    runAxeInIsolatedWorld: async (
      pw: PwPage,
      cdp: CDPSession,
      runOptions: Record<string, unknown>,
      options?: Pick<AxeWorld.AxeWorldOptions, 'stepTimeoutMs'>,
    ): Promise<AxeWorld.AxeWorldResult> => {
      const isolated = await original.runAxeInIsolatedWorld(pw, cdp, runOptions, options);
      if (!comparing) {
        comparing = true;
        try {
          let pageRaw: unknown;
          try {
            pageRaw = await pageWorldRaw(pw, tagsOf(runOptions));
          } catch (error) {
            record({ via: 'isolated run', page: where(pw), error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
            return isolated;
          }
          await compareAndRecord('isolated run', pw, pageRaw, isolated, tagsOf(runOptions));
        } finally {
          comparing = false;
        }
      }
      return isolated;
    },
  };
});

const { runAxeInIsolatedWorld } = await vi.importActual<typeof AxeWorld>('../../src/deps/axe-world.js');

type Analyze = typeof AxeBuilder.prototype.analyze;
const analyze: Analyze = AxeBuilder.prototype.analyze;
AxeBuilder.prototype.analyze = async function (this: AxeBuilder): ReturnType<Analyze> {
  const result = await analyze.call(this);
  if (!comparing) {
    comparing = true;
    try {
      const fields = this as unknown as { page: PwPage; option?: unknown };
      const pw = fields.page;
      const tags = tagsOf(fields.option);
      let isolated: { results: unknown; uncheckedFrames: AxeWorld.UncheckedFrame[] };
      const cdp = await pw.context().newCDPSession(pw);
      try {
        isolated = await runAxeInIsolatedWorld(pw, cdp, runOptionsFor(tags));
      } catch (error) {
        record({ via: 'page-world run', page: where(pw), error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
        return result;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
      await compareAndRecord('page-world run', pw, result, isolated, tags);
    } finally {
      comparing = false;
    }
  }
  return result;
};
