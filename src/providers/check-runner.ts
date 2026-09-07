/**
 * CheckRunner executes one screen scan and returns transcript stops, provider drafts, and coverage gaps.
 * It must never throw, never mint a verdict, and never drop a failed screen on the floor.
 * Transcript collection runs before providers because interaction probes can mutate focus order.
 *
 * A screen the browser was redirected away from is disclosed as a coverage gap and measured no
 * further. See providers/redirected.ts for the rule and what it can and cannot see.
 */
import type {
  Capability,
  BrowserDriver,
  CheckRunner,
  CoverageGap,
  Page,
  Provider,
  ScreenScan,
  Step,
  StepRunner,
  UsablConfig,
} from '../contracts/index.js';
import { attachDomSourceToDrafts } from './dom-source.js';
import { measureReachability } from './reachability.js';
import { observeLanding, redirectedAwayGap } from './redirected.js';
import { runProviders } from './index.js';

export interface CheckRunnerDeps {
  browser: BrowserDriver;
  providers: Provider[];
  config: UsablConfig;
  allowedCapabilities: Capability[];
  stepRunner: StepRunner;
  transcriptTabCap?: number;
}

const DEFAULT_TRANSCRIPT_TAB_CAP = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notCoveredGap(ref: string, reason: string): CoverageGap {
  return { ref, state: 'not-covered', reason };
}

function failedScan(screen: { id: string; url: string }, reason: string): ScreenScan {
  // A scan that failed knows nothing about which rules applied, so it claims nothing. It also made
  // no reachability observation, so both reachability fields stay null. The gap here already tells
  // the operator the screen failed to open.
  return {
    screenId: screen.id,
    url: screen.url,
    stops: [],
    drafts: [],
    gaps: [notCoveredGap(screen.url, reason)],
    applicability: [],
    reachedSelectorPresent: null,
    reachedWhenSelector: null,
  };
}

function makeTabSteps(tabCap: number): Step[] {
  return Array.from({ length: tabCap }, (): Step => ({ do: 'tab' }));
}

function trimCycle(stops: ScreenScan['stops']): ScreenScan['stops'] {
  const seen = new Set<string>();
  for (const [index, stop] of stops.entries()) {
    if (seen.has(stop.elementPath)) {
      return stops.slice(0, index);
    }
    seen.add(stop.elementPath);
  }
  return stops;
}

export function makeCheckRunner(deps: CheckRunnerDeps): CheckRunner {
  const transcriptTabCap = deps.transcriptTabCap ?? DEFAULT_TRANSCRIPT_TAB_CAP;
  const tabSteps = makeTabSteps(transcriptTabCap);

  return {
    async scan(screen): Promise<ScreenScan> {
      let page: Page;
      try {
        page = await deps.browser.open(screen.url);
      } catch (err) {
        return failedScan(screen, `screen failed to open: ${errorMessage(err)}`);
      }

      // Look up the surface's optional reachedWhen selector by screen id. Only manually declared
      // surfaces set an id that matches a scan target, so route-discovered screens find nothing here
      // and make no reachability claim.
      const reachedWhen = deps.config.surfaces.find((surface) => surface.id === screen.id)?.reachedWhen;

      let result: ScreenScan = {
        screenId: screen.id,
        url: screen.url,
        stops: [],
        drafts: [],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
        reachedWhenSelector: reachedWhen ?? null,
      };
      try {
        await page.gotoReady();

        // Where the browser actually landed, read before anything on this page is exercised.
        // Providers click and press keys, and a click can navigate, so a later read could not
        // tell an application's own redirect from a move usabl made itself.
        const redirected = redirectedAwayGap(screen.id, await observeLanding(page, screen.url));
        if (redirected !== null) {
          // Not this screen. The walk and the providers are skipped rather than run and thrown
          // away: a keyboard order and a rule result from a sign-in page are not weak evidence
          // about the requested screen, they are evidence about a different page, and collecting
          // them at all invites a later change to keep them. Nothing is claimed about
          // reachability either, because this page is not the one the assertion describes.
          result = {
            screenId: screen.id,
            url: screen.url,
            stops: [],
            drafts: [],
            gaps: [redirected],
            applicability: [],
            reachedSelectorPresent: null,
            reachedWhenSelector: reachedWhen ?? null,
          };
        } else {
          await page.armAnnouncementCapture();

          const transcript = await deps.stepRunner.run(page, tabSteps);
          const stops = trimCycle(transcript);

          await page.focusBody();
          const providerResult = await runProviders(
            deps.providers,
            { page, screen, config: deps.config, profile: screen.profile ?? 'app' },
            deps.allowedCapabilities,
          );
          const drafts = await attachDomSourceToDrafts(page, providerResult.drafts);

          // Measure reachability after the walk and providers have run, while the page is still
          // open. This is the only place the live DOM exists; markUnseenScreens runs later over
          // collected scans and cannot query the page.
          const reachedSelectorPresent = await measureReachability(page, reachedWhen);

          result = {
            screenId: screen.id,
            url: screen.url,
            stops,
            drafts,
            gaps: providerResult.gaps,
            applicability: providerResult.applicability,
            reachedSelectorPresent,
            reachedWhenSelector: reachedWhen ?? null,
          };
        }
      } catch (err) {
        result = failedScan(screen, `scan failed: ${errorMessage(err)}`);
      } finally {
        try {
          await page.close();
        } catch (err) {
          result = {
            ...result,
            gaps: [...result.gaps, notCoveredGap(screen.url, `scan cleanup failed: ${errorMessage(err)}`)],
          };
        }
      }

      return result;
    },
  };
}
