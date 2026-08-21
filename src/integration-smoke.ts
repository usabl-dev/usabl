/**
 * Real-browser smoke entry for manual local validation of the provider stack.
 * It prints scan evidence only and never decides a verdict outside the gate path.
 * The env guard avoids a fake green when Chromium is unavailable or integration mode is off.
 */
import type { UsablConfig } from './contracts/index.js';
import { makeRealBrowserDriver } from './deps/real.js';
import { axeProvider } from './providers/axe/index.js';
import { makeCheckRunner } from './providers/check-runner.js';
import { makeKeyboardWalkProvider } from './providers/keyboard-walk/index.js';
import { makeStepRunner } from './providers/keyboard-walk/steps.js';
import { makeRulepackProvider } from './providers/rulepack/index.js';

async function main(): Promise<number> {
  if (process.env.USABL_INTEGRATION !== '1') {
    process.stderr.write('Set USABL_INTEGRATION=1 to run integration smoke.\n');
    return 2;
  }

  const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
  const config: UsablConfig = {
    appBaseUrl: url,
    uiFileGlobs: [],
    discovery: { routerFile: '', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
  };

  const browser = makeRealBrowserDriver();
  const runner = makeCheckRunner({
    browser,
    providers: [
      axeProvider,
      makeRulepackProvider(),
      makeKeyboardWalkProvider({ now: Date.now, wallClockMs: 15_000 }),
    ],
    config,
    allowedCapabilities: ['live'],
    stepRunner: makeStepRunner(),
  });

  try {
    const scan = await runner.scan({ id: 'integration-smoke', url });
    process.stdout.write(`stops: ${scan.stops.length} drafts: ${scan.drafts.length} gaps: ${scan.gaps.length}\n`);
    for (const draft of scan.drafts) {
      process.stdout.write(`  [${draft.layer}] ${draft.rule} (${draft.confidence}) @ ${draft.elementPath}\n`);
    }
    for (const gap of scan.gaps) {
      process.stdout.write(`  GAP ${gap.state}: ${gap.reason}\n`);
    }
    return 0;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code));
