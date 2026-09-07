import { defineConfig } from 'vitest/config';
import { DEMO_APP_SUITES } from './vitest.config.js';

// Runs only the suites that drive a live checkout of the demo app.
// Usage: USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
export default defineConfig({
  test: {
    include: DEMO_APP_SUITES,
    environment: 'node',
  },
});
