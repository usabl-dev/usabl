import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli-bin.ts',
    'stop-hook-runner': 'src/surfaces/stop-hook-bin.ts',
    'vite-plugin': 'src/surfaces/vite-plugin.ts',
    'webpack-plugin': 'src/surfaces/webpack-plugin.ts',
    'webpack-loader': 'src/surfaces/webpack-loader.ts',
    'playwright-helper': 'src/surfaces/playwright-helper.ts',
    docs: 'src/surfaces/docs.ts',
    measure: 'src/measure/fleet-insights.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
