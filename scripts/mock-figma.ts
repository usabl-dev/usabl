/**
 * Serves the mock Figma API on this machine, to try `usabl import figma` and `usabl drift design`
 * without a Figma account: `npx vite-node scripts/mock-figma.ts [--port 4010]`. Then set
 * FIGMA_API_BASE=http://127.0.0.1:4010 and FIGMA_TOKEN=mock-figma-token, and use the file key
 * MOCKKEY. The mock file is built from Figma's published file format. Stop it with Ctrl+C.
 */
import { MOCK_FILE_KEY, MOCK_TOKEN, startMockFigma } from '../test/import/figma/mock-server.js';

const flag = process.argv.indexOf('--port');
const port = flag >= 0 ? Number(process.argv[flag + 1]) : 4010;
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('usage: vite-node scripts/mock-figma.ts [--port <1-65535>]\n');
  process.exit(2);
}

const mock = await startMockFigma(undefined, port);
process.stdout.write(`Mock Figma API on ${mock.base}. Token: ${MOCK_TOKEN}. File key: ${MOCK_FILE_KEY}.\n`);
