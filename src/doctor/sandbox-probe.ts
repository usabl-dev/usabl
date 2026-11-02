/**
 * Probe for whether Chromium can start its sandbox on this system. Doctor uses it so an operator
 * learns before a scan that usabl would run its browser without the sandbox, or refuse to scan
 * when browserSandbox is "require".
 *
 * It starts a real scan browser the way a scan does, opens one blank page, and closes it. It
 * writes nothing to the repository. A launch that fails for a reason other than the sandbox, such
 * as a missing Chromium, says nothing about the sandbox, so it is unknown, never available.
 */
import { launchScanBrowser, type LaunchedBrowser, type ScanBrowserLaunch } from '../deps/real.js';
import { isSandboxLaunchFailure } from '../deps/sandbox.js';

export type ChromiumSandboxProbe = 'available' | 'unavailable' | 'unknown';

export async function probeChromiumSandbox(
  launch: (options: ScanBrowserLaunch) => Promise<LaunchedBrowser> = launchScanBrowser,
): Promise<ChromiumSandboxProbe> {
  let browser: LaunchedBrowser;
  try {
    browser = await launch({ chromiumSandbox: true });
  } catch (error) {
    return isSandboxLaunchFailure(error instanceof Error ? error.message : String(error)) ? 'unavailable' : 'unknown';
  }
  try {
    const context = await browser.newContext();
    await context.newPage();
    return 'available';
  } catch (error) {
    return isSandboxLaunchFailure(error instanceof Error ? error.message : String(error)) ? 'unavailable' : 'unknown';
  } finally {
    await browser.close().catch(() => undefined);
  }
}
