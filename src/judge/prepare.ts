/**
 * What `check --isolated-browser` does around one run. It reads the origins the browser may reach
 * from the trusted ref (never from the head's working tree when a ref is given), checks the build
 * digest the workflow handed it, counts the requests the browser blocks, and adds the judge block
 * to the Result. It decides nothing: blocked requests reach the gate as coverage gaps, which the
 * check runner adds per screen.
 */
import type { Result } from '../contracts/index.js';
import { judgeDisclosure } from './disclosure.js';
import { allowedOriginsFrom, blockedOriginLabel, type BrowserIsolation } from './request-filter.js';

export interface PrepareJudgeInput {
  trustedRef: string | null;
  configPath: string;
  buildDigestEnv: string | undefined;
  readAtRef: (ref: string, path: string) => Promise<string | null>;
  readWorking: (path: string) => Promise<string | null>;
  log: (text: string) => void;
}

export type PreparedJudge =
  | { ok: true; isolation: BrowserIsolation; finish: (result: Result) => Result }
  | { ok: false; message: string };

export async function prepareJudge(input: PrepareJudgeInput): Promise<PreparedJudge> {
  const digestCheck = judgeDisclosure(0, input.buildDigestEnv);
  if (!digestCheck.ok) {
    return { ok: false, message: digestCheck.message };
  }
  const read = (path: string): Promise<string | null> =>
    input.trustedRef === null ? input.readWorking(path) : input.readAtRef(input.trustedRef, path);
  const configRaw = await read(input.trustedRef === null ? input.configPath : 'usabl.config.json');
  const docsRaw = await read('usabl.docs.json');
  const origins = allowedOriginsFrom(configRaw, docsRaw);
  if (origins.length === 0) {
    input.log(
      'usabl: the isolated browser has no trusted origin to allow, so every request will be blocked and every screen will be a coverage gap\n',
    );
  }

  let blocked = 0;
  const loggedOrigins = new Set<string>();
  const isolation: BrowserIsolation = {
    allowedOrigins: new Set(origins),
    onBlocked: (url) => {
      blocked += 1;
      const origin = blockedOriginLabel(url);
      if (!loggedOrigins.has(origin)) {
        loggedOrigins.add(origin);
        input.log(`usabl: the isolated browser blocked a request to ${origin}\n`);
      }
    },
  };
  return {
    ok: true,
    isolation,
    finish: (result) => ({
      ...result,
      judge: { isolatedBrowser: true, blockedRequests: blocked, buildDigest: digestCheck.judge.buildDigest },
    }),
  };
}
