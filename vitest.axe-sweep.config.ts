import { defineConfig } from 'vitest/config';

// The axe comparison sweep: the tests that drive a real browser, with every axe run compared
// against axe run the other way. See test/support/axe-sweep-setup.ts. Run it with
// USABL_INTEGRATION=1 and USABL_AXE_SWEEP_LOG set to a file for the results.
export const SWEEP_FILES = [
  'test/deps/real.integration.test.ts',
  'test/deps/readiness.real.test.ts',
  'test/deps/menu-state.real.integration.test.ts',
  'test/deps/shared-browser.test.ts',
  'test/deps/build.test.ts',
  'test/surfaces/playwright-page-check.integration.test.ts',
  'test/surfaces/playwright-helper.test.ts',
  'test/surfaces/webpack-overlay.integration.test.ts',
  'test/surfaces/overlay-client.test.ts',
  'test/session/session-login.integration.test.ts',
  'test/baseline/row-stability.real.integration.test.ts',
  'test/baseline/row-identity.real.integration.test.ts',
  'test/providers/pf6-real-markup.test.ts',
  'test/providers/pf6-block-selectors.test.ts',
  'test/providers/toast-live-ancestors.test.ts',
];

export default defineConfig({
  test: {
    include: SWEEP_FILES,
    setupFiles: ['test/support/axe-sweep-setup.ts'],
    environment: 'node',
    // One file at a time: the sweep doubles every axe run, and the machine it runs on is shared.
    fileParallelism: false,
  },
});
