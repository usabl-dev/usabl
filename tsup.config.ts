import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli-bin.ts',
    'stop-hook-runner': 'src/surfaces/stop-hook-bin.ts',
    'vite-plugin': 'src/surfaces/vite-plugin.ts',
    'playwright-helper': 'src/surfaces/playwright-helper.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
