/**
 * CheckRunner executes one screen scan and returns transcript stops, provider drafts, and coverage gaps.
 * It must never throw, never mint a verdict, and never drop a failed screen on the floor.
 * Transcript collection runs before providers because interaction probes can mutate focus order.
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
  return { screenId: screen.id, url: screen.url, stops: [], drafts: [], gaps: [notCoveredGap(screen.url, reason)] };
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

      let result: ScreenScan = { screenId: screen.id, url: screen.url, stops: [], drafts: [], gaps: [] };
      try {
        await page.gotoReady();
        await page.armAnnouncementCapture();

        const transcript = await deps.stepRunner.run(page, tabSteps);
        const stops = trimCycle(transcript);

        await page.focusBody();
        const providerResult = await runProviders(
          deps.providers,
          { page, screen, config: deps.config, profile: screen.profile ?? 'app' },
          deps.allowedCapabilities,
        );

        result = {
          screenId: screen.id,
          url: screen.url,
          stops,
          drafts: providerResult.drafts,
          gaps: providerResult.gaps,
        };
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
