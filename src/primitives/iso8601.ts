/**
 * Strict UTC timestamp checks for ledger fields compared lexically later.
 * This unit validates format only. It must never decide waiver activity or a verdict.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function assertIso8601Utc(value: string, field: string): void {
  const message = `${field} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`;
  if (!ISO_8601_UTC.test(value)) {
    throw new Error(message);
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error(message);
  }
  if (canonical !== value) {
    throw new Error(message);
  }
}
