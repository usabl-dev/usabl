import { configDefaults, defineConfig } from 'vitest/config';

// The demo-app suites need a live checkout of the demo app and Chromium. They run
// only through vitest.demo.config.ts (npm run test:demo-integration).
export const DEMO_APP_SUITES = ['test/integration/hero-bug-flip.test.ts', 'test/integration/fixture-clean.test.ts'];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...DEMO_APP_SUITES],
    environment: 'node',
  },
});
