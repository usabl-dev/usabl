/**
 * A webpack app shaped like patternfly-react-seed, for the webpack overlay plugin tests.
 *
 * The app source lives in fixtures/webpack-app: TypeScript and JSX built by ts-loader, with a small
 * `h` factory in place of React so the fixture needs no React install. The configs are built here
 * the way the seed builds them: one common config for loaders and output, merged with a
 * development config (mode, dev server) or a production config (mode only). They are built in code
 * because they take the plugin under test as an argument.
 *
 * src/app/App.tsx holds one known accessibility barrier: a button with no accessible name, on
 * BARRIER_LINE.
 */
import { cp, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/webpack-app', import.meta.url));
export const BARRIER_FILE = 'src/app/App.tsx';
export const BARRIER_LINE = 8;

/** Copies the fixture into a fresh temporary directory and returns its path. */
export async function copySeedApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-webpack-app-'));
  await cp(FIXTURE_DIR, root, { recursive: true });
  return root;
}

type Plugin = { apply(compiler: never): void };

// The seed's webpack.common.js, reduced to what this app uses. The rule test is the seed's own,
// optional extension group and all, so a plugin that adds its own rule meets the same matcher.
function common(root: string, plugins: Plugin[]): Record<string, unknown> {
  return {
    context: root,
    entry: { main: join(root, 'src', 'index.tsx') },
    module: {
      rules: [
        {
          test: /\.(tsx|ts|jsx)?$/,
          use: [
            {
              loader: require.resolve('ts-loader'),
              options: { transpileOnly: true, configFile: join(root, 'tsconfig.json') },
            },
          ],
        },
      ],
    },
    output: {
      filename: '[name].bundle.js',
      path: join(root, 'dist'),
      publicPath: '/',
    },
    plugins,
    resolve: { extensions: ['.js', '.ts', '.tsx', '.jsx'] },
    infrastructureLogging: { level: 'error' },
    stats: 'errors-only',
  };
}

/** The seed's webpack.dev.js: development mode and a dev server on 127.0.0.1. */
export function seedDevConfig(root: string, plugins: Plugin[], port: number): Record<string, unknown> {
  return {
    ...common(root, plugins),
    mode: 'development',
    devtool: 'eval-source-map',
    devServer: {
      host: '127.0.0.1',
      port,
      historyApiFallback: true,
      hot: false,
      liveReload: false,
      static: { directory: join(root, 'src') },
      client: false,
    },
  };
}

/** The seed's webpack.prod.js: production mode, no dev server. */
export function seedProdConfig(root: string, plugins: Plugin[]): Record<string, unknown> {
  return {
    ...common(root, plugins),
    mode: 'production',
    devtool: 'source-map',
  };
}
