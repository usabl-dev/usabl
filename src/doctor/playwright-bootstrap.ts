/**
 * Read-only probe for whether Playwright's Chromium browser is installed. Doctor uses this
 * so a missing headless browser is reported before "usabl check" returns not_covered with
 * an opaque launch error.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright';

export type PlaywrightBootstrapProbe = 'wired' | 'missing' | 'unknown';

// Best-effort recognizer for Playwright's "browser not downloaded" errors. Playwright rewords
// these between releases, so message matching is version-fragile. ENOENT from access() and
// executablePath() is the real signal; the strings below are a fallback only.
function isMissingExecutableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('executable doesn\'t exist') ||
    message.includes('executable does not exist') ||
    message.includes('please run the following command to download new browsers')
  );
}

export async function probePlaywrightChromium(): Promise<PlaywrightBootstrapProbe> {
  try {
    const executablePath = chromium.executablePath();
    // X_OK confirms the path is executable, not merely present. It does not prove Chromium
    // can launch (missing shared libraries still fail at runtime); doctor's next step covers that.
    await access(executablePath, constants.X_OK);
    return 'wired';
  } catch (error) {
    if (isMissingExecutableError(error)) {
      return 'missing';
    }
    // Fs read failures propagate to guardRead (unknown). Programmer errors propagate to exit 4.
    throw error;
  }
}
