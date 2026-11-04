/**
 * The judge block on a Result: disclosure that the trusted judge produced it. It records that the
 * browser was isolated, how many requests it blocked, and the digest of the build it scanned, so
 * the verdict is bound to those exact bytes. It never changes a verdict. A blocked request is
 * already a coverage gap on its screen, decided by the check runner and the gate.
 */
import type { JudgeDisclosure } from '../contracts/index.js';

const DIGEST = /^[0-9a-f]{64}$/;

export function isJudgeDisclosure(value: unknown): value is JudgeDisclosure {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const isolated = Reflect.get(value, 'isolatedBrowser');
  const blocked = Reflect.get(value, 'blockedRequests');
  const digest = Reflect.get(value, 'buildDigest');
  return (
    isolated === true &&
    typeof blocked === 'number' &&
    Number.isInteger(blocked) &&
    blocked >= 0 &&
    (digest === null || (typeof digest === 'string' && DIGEST.test(digest)))
  );
}

// The digest arrives through the environment from the workflow, which has already checked it
// against the build job's output. It is checked again here, because a malformed value in a Result
// would read as a binding that does not hold.
export function judgeDisclosure(
  blockedRequests: number,
  buildDigestEnv: string | undefined,
): { ok: true; judge: JudgeDisclosure } | { ok: false; message: string } {
  const digest = buildDigestEnv === undefined || buildDigestEnv === '' ? null : buildDigestEnv;
  if (digest !== null && !DIGEST.test(digest)) {
    return { ok: false, message: 'USABL_BUILD_DIGEST must be a sha256 digest of 64 lowercase hex characters' };
  }
  return { ok: true, judge: { isolatedBrowser: true, blockedRequests, buildDigest: digest } };
}

export function judgeLine(judge: JudgeDisclosure): string {
  const digest = judge.buildDigest === null ? 'no build digest recorded' : `build sha256 ${judge.buildDigest}`;
  return `isolated browser, ${judge.blockedRequests} request(s) outside the allowed origins blocked, ${digest}`;
}
