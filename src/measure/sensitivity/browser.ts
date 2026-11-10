/**
 * The scan browser for the sensitivity command: a browser driver that can be armed with one
 * catalog mutation for the next page it opens.
 *
 * An armed page is the base driver's page with two changes. After gotoReady the target finder runs
 * and the edit is made, so the change lands after the page is ready and before the transcript walk
 * or any provider runs. And close is held until the runner releases the page, so the runner can
 * ask where each reported element sits relative to what the edit changed, on the page the checks
 * saw. A page opened while nothing is armed is the base driver's page, unchanged.
 *
 * This driver exists only in the sensitivity command's composition. The normal composition root,
 * buildDeps, never builds it, and no config field or environment variable can turn it on.
 */
import type { BrowserDriver, Page, ReadinessOutcome, ReadinessProbe } from '../../contracts/index.js';
import { carryPlaywrightPage } from '../../providers/engines/shared.js';
import type { CatalogEntry } from './catalog.js';
import type { AppliedEdit, MutationEditor } from './edits.js';
import { findTargets } from './targets.js';

/** What became of an armed mutation. */
export type MutationRecord =
  | { kind: 'applied'; targets: string[]; edit: AppliedEdit }
  | { kind: 'no-target'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'not-reached'; reason: string };

export interface ArmedMutation {
  // Read after the scan. Before the page was ready it is not-reached.
  record(): MutationRecord;
  // Lets go of the edit and closes the page the scan opened. Call it once, after the scan.
  release(): Promise<void>;
}

export interface MutatingBrowser extends BrowserDriver {
  // Arms the next open with this mutation. Only one mutation is armed at a time.
  arm(mutation: CatalogEntry['mutation']): ArmedMutation;
}

const NOT_REACHED = 'the scan did not reach the moment the edit is made, after the page was ready';

export function makeMutatingBrowser(base: BrowserDriver, editor: MutationEditor): MutatingBrowser {
  let armed: { mutation: CatalogEntry['mutation']; state: ArmState } | null = null;

  interface ArmState {
    record: MutationRecord;
    close: (() => Promise<void>) | null;
  }

  return {
    arm(mutation) {
      if (armed !== null) {
        throw new Error('a sensitivity mutation is already armed');
      }
      const state: ArmState = { record: { kind: 'not-reached', reason: NOT_REACHED }, close: null };
      armed = { mutation, state };
      return {
        record: () => state.record,
        async release() {
          if (armed?.state === state) {
            armed = null;
          }
          if (state.record.kind === 'applied') {
            await state.record.edit.release();
          }
          const close = state.close;
          state.close = null;
          if (close !== null) {
            try {
              await close();
            } catch {
              // The scan is over and its result is kept. A page that will not close says nothing
              // about the defect the scan measured.
            }
          }
        },
      };
    },

    async open(url: string): Promise<Page> {
      const page = await base.open(url);
      const plan = armed;
      if (plan === null) {
        return page;
      }
      // One page per arming. A later open in the same scan, if there were one, would be unmutated.
      armed = null;
      const { mutation, state } = plan;
      return carryPlaywrightPage(page, {
        ...page,
        async gotoReady(readyWhen?: ReadinessProbe): Promise<ReadinessOutcome> {
          const readiness = await page.gotoReady(readyWhen);
          if (readiness.signal === 'timed-out') {
            state.record = { kind: 'not-reached', reason: 'the page did not show its readiness signal, so no edit was made' };
            return readiness;
          }
          const found = await findTargets(page, mutation.target);
          if (found.kind === 'none') {
            state.record = { kind: 'no-target', reason: found.reason };
            return readiness;
          }
          const outcome = await editor.apply(page, found.paths, mutation.edit);
          state.record =
            outcome.kind === 'applied'
              ? { kind: 'applied', targets: found.paths, edit: outcome.edit }
              : { kind: 'failed', reason: outcome.reason };
          return readiness;
        },
        async close(): Promise<void> {
          // Held until release, so the runner can locate reported elements on this page.
          state.close = () => page.close();
        },
      });
    },

    close: () => base.close(),
  };
}
