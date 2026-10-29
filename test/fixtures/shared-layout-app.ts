/**
 * An app whose shared layout component is imported by every route, through an `@/` alias the
 * repository never configures. usabl cannot follow the import, so it cannot place the layout on
 * any screen, while every route entry file maps to its own screen.
 */
import type { UsablConfig } from '../../src/contracts/index.js';

export const SHARED_LAYOUT_FILE = 'src/layout/AppLayout.tsx';

export const sharedLayoutConfig: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
};

const page = (name: string): string =>
  `import { AppLayout } from '@/layout/AppLayout'\nexport function ${name}() { return <AppLayout /> }\n`;

export const sharedLayoutFiles: Record<string, string> = {
  'usabl.config.json': `${JSON.stringify(sharedLayoutConfig)}\n`,
  'usabl.routes.json': `${JSON.stringify({
    routes: [
      { screenId: 'home', url: '/', entryFile: 'src/pages/Home.tsx' },
      { screenId: 'settings', url: '/settings', entryFile: 'src/pages/Settings.tsx' },
    ],
  })}\n`,
  'src/pages/Home.tsx': page('Home'),
  'src/pages/Settings.tsx': page('Settings'),
  [SHARED_LAYOUT_FILE]: 'export function AppLayout() { return null }\n',
};
