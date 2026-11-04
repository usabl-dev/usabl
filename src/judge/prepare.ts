/**
 * What `check --isolated-browser` does around one run. It reads the origins the browser may reach
 * from the trusted ref (never from the head's working tree when a ref is given), checks the build
 * digest the workflow handed it, counts the requests the browser blocks, and adds the judge block
 * to the Result. It decides nothing: blocked requests reach the gate as coverage gaps, which the
 * check runner adds per screen.
 *
 * With a trusted ref it also hands back the trusted usabl.config.json, parsed, and the judge runs
 * on it: every runtime setting, such as the readiness budget, comes from the trusted commit. The
 * head's copy is only compared with it by the guard, so a head that breaks or rewrites the file
 * is reported as a policy change instead of steering or stopping the judge.
 */
import type { Result, UsablConfig } from '../contracts/index.js';
import { parseUsablConfig } from '../intake/config.js';
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
  // config is the trusted config, or null when there is no trusted ref or it has no readable
  // config. In the second case the caller must not take runtime settings from the head.
  | { ok: true; isolation: BrowserIsolation; config: UsablConfig | null; finish: (result: Result) => Result }
  | { ok: false; message: string };

// The settings that change how the judge runs rather than what it plans. When the trusted ref has
// no readable config, the head's copy is still used to plan, and these are taken out of it, so the
// engine defaults apply instead of the head's.
export function withoutRuntimeSettings(config: UsablConfig): UsablConfig {
  const { readyTimeoutMs: _ready, signalTimeoutMs: _signal, browserSandbox: _sandbox, judge: _judge, ...rest } = config;
  return rest;
}

function parseTrusted(raw: string | null): UsablConfig | null {
  if (raw === null) return null;
  try {
    return parseUsablConfig(raw);
  } catch {
    return null;
  }
}

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
    config: input.trustedRef === null ? null : parseTrusted(configRaw),
    finish: (result) => ({
      ...result,
      judge: { isolatedBrowser: true, blockedRequests: blocked, buildDigest: digestCheck.judge.buildDigest },
    }),
  };
}
