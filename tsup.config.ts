import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', 'stop-hook-runner': 'src/surfaces/stop-hook-runner.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
