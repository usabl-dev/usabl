/**
 * The mutation editor for the real scan browser. It reaches the Playwright page behind a usabl page
 * the real driver opened and runs the engine's two fixed page functions there, with the edit and
 * the target paths as JSON arguments.
 *
 * Measurement only. Only the sensitivity command builds this editor.
 */
import type { JSHandle, Page as PwPage } from 'playwright';
import type { Page } from '../../contracts/index.js';
import { playwrightPageOf } from '../../providers/engines/shared.js';
import type { Edit } from './catalog.js';
import { applyEditInPage, locateInPage, type EditOutcome, type EditResultInPage, type MutationEditor } from './edits.js';

function isPlaywrightPage(value: unknown): value is PwPage {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'evaluateHandle') === 'function';
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // The first line only. Playwright adds a call log after it that can quote the page.
  return text.split('\n')[0] ?? '';
}

export function makeRealMutationEditor(): MutationEditor {
  return {
    async apply(page: Page, targets: readonly string[], edit: Edit): Promise<EditOutcome> {
      const pw = playwrightPageOf(page);
      if (!isPlaywrightPage(pw)) {
        return { kind: 'failed', reason: 'the page was not opened by the scan browser, so no edit can reach it' };
      }
      let handle: JSHandle<EditResultInPage>;
      try {
        handle = await pw.evaluateHandle(applyEditInPage, { targets: [...targets], edit });
      } catch (err) {
        return { kind: 'failed', reason: `the edit could not run in the page: ${errorMessage(err)}` };
      }
      const ok = await (await handle.getProperty('ok')).jsonValue();
      if (ok !== true) {
        const reason = await (await handle.getProperty('reason')).jsonValue();
        await handle.dispose();
        return { kind: 'failed', reason: typeof reason === 'string' ? reason : 'the edit did not hold' };
      }
      return {
        kind: 'applied',
        edit: {
          async locate(paths: readonly string[]) {
            return handle.evaluate(locateInPage, [...paths]);
          },
          async release() {
            try {
              await handle.dispose();
            } catch {
              // The page is already gone, and the handle with it.
            }
          },
        },
      };
    },
  };
}
