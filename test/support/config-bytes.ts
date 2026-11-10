/**
 * Config bytes for Stop hook tests whose subject is not the config comparison. The working tree
 * and the last commit hold the same bytes, which is the state the hook goes on from as before.
 * The comparison itself is held in stop-hook-config.test.ts.
 */
import type { ConfigBytes } from '../../src/surfaces/stop-hook-runner.js';

export function committedConfigBytes(text = '{}'): ConfigBytes {
  return { working: { status: 'found', text }, head: { status: 'found', text } };
}
