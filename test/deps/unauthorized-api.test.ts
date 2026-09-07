/**
 * The primary signal for "this run did not reach the screen signed in": the page's own data
 * requests came back 401.
 *
 * Why this and not the address or the DOM. The application that produced the defect never leaves
 * the requested URL. It renders a blank shell for over five seconds, then swaps a login form in at
 * the same address, so a scan that settles mid transition sees neither a changed URL nor a password
 * field. Its API calls to identity endpoints are refused from the first moment of load, so this
 * signal is present before anything renders and cannot be raced by render timing. On a healthy
 * signed-in load of the same screen, nine API responses were all 200 and there were no 401s.
 *
 * The rule is narrow on purpose and both halves are held here: only 401, and only the page's own
 * fetch or XHR traffic.
 */
import { describe, expect, it } from 'vitest';
import { makeNetworkActivityTracker, type RequestEvents, type ResponseEvent } from '../../src/deps/real.js';

interface Emitter {
  page: RequestEvents;
  respond(spec: { status: number; url: string; resourceType: string }): void;
}

function emitter(): Emitter {
  const responseHandlers: Array<(response: ResponseEvent) => void> = [];
  const page = {
    on(event: string, handler: unknown): void {
      if (event === 'response') {
        responseHandlers.push(handler as (response: ResponseEvent) => void);
      }
    },
  } as unknown as RequestEvents;
  return {
    page,
    respond(spec) {
      const response: ResponseEvent = {
        status: () => spec.status,
        url: () => spec.url,
        request: () => ({ resourceType: () => spec.resourceType }),
      };
      for (const handler of responseHandlers) {
        handler(response);
      }
    },
  };
}

describe('the tracker records the page data requests that were refused', () => {
  it('records a 401 fetch and a 401 xhr, in arrival order', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    respond({ status: 200, url: 'http://app.test/api/v2/ping', resourceType: 'fetch' });
    respond({ status: 401, url: 'http://app.test/api/v2/me', resourceType: 'fetch' });
    respond({ status: 401, url: 'http://app.test/api/v2/config', resourceType: 'xhr' });

    expect(tracker.unauthorizedApiUrls()).toEqual([
      'http://app.test/api/v2/me',
      'http://app.test/api/v2/config',
    ]);
  });

  it('records nothing on a healthy signed-in load', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    for (let index = 0; index < 9; index += 1) {
      respond({ status: 200, url: `http://app.test/api/v2/r${index}`, resourceType: 'fetch' });
    }

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('ignores 403, which means authenticated and not permitted', () => {
    // A signed-in scan can legitimately meet a resource this identity may not have. Treating that
    // as a dead session would turn a correct run into a coverage gap. 401 is the one status HTTP
    // defines as "not authenticated".
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    respond({ status: 403, url: 'http://app.test/api/v2/admin', resourceType: 'fetch' });
    respond({ status: 404, url: 'http://app.test/api/v2/gone', resourceType: 'fetch' });
    respond({ status: 500, url: 'http://app.test/api/v2/boom', resourceType: 'xhr' });

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('ignores a 401 on an asset, which is a missing file and not a refused session', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    for (const resourceType of ['document', 'stylesheet', 'image', 'font', 'script', 'media']) {
      respond({ status: 401, url: `http://app.test/${resourceType}`, resourceType });
    }

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('survives a response that throws when read, and keeps the rest', () => {
    // A response from a frame that has already gone can throw on a status read. A listener that
    // threw would take down the page event emitter and cost the whole scan.
    const responseHandlers: Array<(response: ResponseEvent) => void> = [];
    const page = {
      on(event: string, handler: unknown): void {
        if (event === 'response') {
          responseHandlers.push(handler as (response: ResponseEvent) => void);
        }
      },
    } as unknown as RequestEvents;
    const tracker = makeNetworkActivityTracker(page);

    const exploding: ResponseEvent = {
      status: () => {
        throw new Error('response is gone');
      },
      url: () => 'http://app.test/api/gone',
      request: () => ({ resourceType: () => 'fetch' }),
    };
    const refused: ResponseEvent = {
      status: () => 401,
      url: () => 'http://app.test/api/v2/me',
      request: () => ({ resourceType: () => 'fetch' }),
    };

    for (const handler of responseHandlers) {
      expect(() => handler(exploding)).not.toThrow();
      handler(refused);
    }

    expect(tracker.unauthorizedApiUrls()).toEqual(['http://app.test/api/v2/me']);
  });

  it('hands back a copy, so a caller cannot edit the record', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);
    respond({ status: 401, url: 'http://app.test/api/v2/me', resourceType: 'fetch' });

    tracker.unauthorizedApiUrls().push('http://app.test/api/v2/invented');

    expect(tracker.unauthorizedApiUrls()).toEqual(['http://app.test/api/v2/me']);
  });
});
