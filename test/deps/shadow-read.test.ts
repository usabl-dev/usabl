import type { CDPSession } from 'playwright';
import { describe, expect, it } from 'vitest';
import { backendNodeIdInShadowRoot } from '../../src/deps/real.js';

// A scripted CDP session: it answers the world setup, then answers the shadow read the way the
// test asks, and records every command it was sent.
function scriptedCdp(evaluate: unknown, describe: unknown = { node: { backendNodeId: 42 } }): { cdp: CDPSession; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  const answers: Record<string, unknown> = {
    'Page.getFrameTree': { frameTree: { frame: { id: 'main' } } },
    'Page.createIsolatedWorld': { executionContextId: 7 },
    'Runtime.evaluate': evaluate,
    'DOM.describeNode': describe,
  };
  const cdp = {
    send: async (method: string, params: unknown) => {
      sent.push([method, params]);
      return answers[method] ?? {};
    },
  } as unknown as CDPSession;
  return { cdp, sent };
}

const released = (sent: Array<[string, unknown]>): unknown[] =>
  sent.filter(([method]) => method === 'Runtime.releaseObjectGroup').map(([, params]) => params);

describe('backendNodeIdInShadowRoot', () => {
  it('returns the backend node of the element it found and releases its object group', async () => {
    const { cdp, sent } = scriptedCdp({ result: { objectId: 'obj-1' } });
    expect(await backendNodeIdInShadowRoot(cdp, '#host', 'button')).toBe(42);
    expect(released(sent)).toEqual([{ objectGroup: 'usabl-shadow-node' }]);
  });

  it('returns null when nothing matched, and still releases the group', async () => {
    const { cdp, sent } = scriptedCdp({ result: { type: 'object', subtype: 'null', value: null } });
    expect(await backendNodeIdInShadowRoot(cdp, '#host', 'button')).toBeNull();
    expect(released(sent)).toEqual([{ objectGroup: 'usabl-shadow-node' }]);
  });

  it('releases the group that holds the thrown value when the read throws', async () => {
    const { cdp, sent } = scriptedCdp({
      result: { objectId: 'thrown-1' },
      exceptionDetails: { text: 'Uncaught', exception: { objectId: 'thrown-1', description: 'SyntaxError: bad selector' } },
    });
    await expect(backendNodeIdInShadowRoot(cdp, '#host', '>>')).rejects.toThrow('SyntaxError: bad selector');
    expect(released(sent)).toEqual([{ objectGroup: 'usabl-shadow-node' }]);
  });
});
