import type { UsablConfig } from '../src/contracts/index.js';

const BASE_CONFIG: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: {
    routerFile: 'fixtures/app/src/App.tsx',
    wideBlastGlobs: [],
  },
  surfaces: [
    {
      id: 'clusters',
      url: 'http://127.0.0.1:5173/clusters',
      files: ['fixtures/app/src/ClustersPage.tsx'],
    },
  ],
  guardedPaths: ['usabl.config.json'],
};

export function testConfig(overrides: Partial<UsablConfig> = {}): UsablConfig {
  return {
    appBaseUrl: overrides.appBaseUrl ?? BASE_CONFIG.appBaseUrl,
    uiFileGlobs: overrides.uiFileGlobs ?? BASE_CONFIG.uiFileGlobs,
    discovery: {
      routerFile: overrides.discovery?.routerFile ?? BASE_CONFIG.discovery.routerFile,
      wideBlastGlobs: overrides.discovery?.wideBlastGlobs ?? BASE_CONFIG.discovery.wideBlastGlobs,
    },
    surfaces: overrides.surfaces ?? BASE_CONFIG.surfaces,
    guardedPaths: overrides.guardedPaths ?? BASE_CONFIG.guardedPaths,
    ...(overrides.readyTimeoutMs !== undefined ? { readyTimeoutMs: overrides.readyTimeoutMs } : {}),
    ...(overrides.requirements !== undefined ? { requirements: overrides.requirements } : {}),
    ...(overrides.promotedObligations !== undefined
      ? { promotedObligations: overrides.promotedObligations }
      : {}),
  };
}
