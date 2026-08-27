/**
 * Strict UTC timestamp checks for ledger fields compared lexically later.
 * This unit validates format only. It must never decide waiver activity or a verdict.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function assertIso8601Utc(value: string, field: string): void {
  if (!ISO_8601_UTC.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`);
  }
}
