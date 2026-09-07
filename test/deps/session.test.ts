/**
 * The session resolver decides whether a run scans signed in or signed out, so its rules are
 * held here directly rather than only through buildDeps. Three of them are honesty rules: an
 * empty variable is not a session, a path usabl cannot read stops the run instead of quietly
 * producing a signed-out scan that still mints a verdict (issue #152), and a session whose
 * cookies have all expired stops it for the same reason. Messages are asserted to exclude the
 * path, because the path can name a private location and the file it names holds live session
 * tokens.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStorageStateExpired,
  readStorageStateEnv,
  resolveStorageStatePath,
  STORAGE_STATE_ENV_VAR,
} from "../../src/deps/session.js";

const VALID_STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

// A fixed instant to judge expiry against, so the rule is not tested against the wall clock.
const NOW_MS = Date.UTC(2026, 8, 7, 12, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;

function cookie(expires: number): Record<string, unknown> {
  return {
    name: "session",
    value: "not-a-real-token",
    domain: "app.test",
    path: "/",
    expires,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
}

describe("readStorageStateEnv", () => {
  it("reads a configured path", () => {
    expect(
      readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "/tmp/session.json" }),
    ).toBe("/tmp/session.json");
  });

  it("trims surrounding whitespace a shell export can leave behind", () => {
    expect(
      readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "  /tmp/session.json\n" }),
    ).toBe("/tmp/session.json");
  });

  it("treats an unset, empty, or whitespace-only value as no session", () => {
    expect(readStorageStateEnv({})).toBeNull();
    expect(readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "" })).toBeNull();
    expect(readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "   " })).toBeNull();
  });
});

describe("resolveStorageStatePath", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "usabl-session-resolve-"));
    statePath = join(dir, "storage-state.json");
    await writeFile(statePath, VALID_STORAGE_STATE, "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the environment path when the file reads and parses", async () => {
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: statePath } }),
    ).resolves.toBe(statePath);
  });

  it("returns null when no session is configured", async () => {
    await expect(resolveStorageStatePath({ env: {} })).resolves.toBeNull();
  });

  it("lets an explicit caller path win over the environment", async () => {
    // Load-bearing: measurement scripts pass a session directly, and a stray variable in the
    // operator's shell must not redirect a script that was told which session to use.
    await expect(
      resolveStorageStatePath({
        explicit: "/tmp/explicit-session.json",
        env: { [STORAGE_STATE_ENV_VAR]: statePath },
      }),
    ).resolves.toBe("/tmp/explicit-session.json");
  });

  it("throws when the environment path cannot be read, and never prints it", async () => {
    const missing = join(dir, "absent-session.json");
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: missing } }),
    ).rejects.toThrow(STORAGE_STATE_ENV_VAR);
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: missing } }),
    ).rejects.not.toThrow(missing);
  });

  it("throws when the environment path is not JSON, and never quotes the contents", async () => {
    const junkPath = join(dir, "not-json.json");
    await writeFile(junkPath, "cookie=letmein", "utf8");
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: junkPath } }),
    ).rejects.toThrow(/not JSON/);
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: junkPath } }),
    ).rejects.not.toThrow(/letmein/);
  });

  it("throws when every cookie that carries an expiry is past it, and says to mint a new session", async () => {
    // The cheap half of the expired-session fix. The file reads and parses, so nothing upstream
    // objects, but no cookie in it can authenticate anything. Stopping here costs one file read
    // and never opens a browser, and the run mints no verdict at all.
    const deadPath = join(dir, "dead-session.json");
    await writeFile(
      deadPath,
      JSON.stringify({
        cookies: [cookie(NOW_SECONDS - 3_600), cookie(NOW_SECONDS - 60)],
        origins: [{ origin: "http://app.test", localStorage: [{ name: "token", value: "letmein" }] }],
      }),
      "utf8",
    );

    const attempt = (): Promise<string | null> =>
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: deadPath }, now: NOW_MS });

    await expect(attempt()).rejects.toThrow(/session has expired/);
    await expect(attempt()).rejects.toThrow(/[Mm]int a new session/);
    await expect(attempt()).rejects.toThrow(STORAGE_STATE_ENV_VAR);
    // Same rule as every other message here: no path, no cookie value, no local storage value.
    await expect(attempt()).rejects.not.toThrow(deadPath);
    await expect(attempt()).rejects.not.toThrow(/not-a-real-token/);
    await expect(attempt()).rejects.not.toThrow(/letmein/);
  });

  it("accepts a session with one cookie still in date", async () => {
    const livePath = join(dir, "live-session.json");
    await writeFile(
      livePath,
      JSON.stringify({ cookies: [cookie(NOW_SECONDS - 60), cookie(NOW_SECONDS + 3_600)], origins: [] }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: livePath }, now: NOW_MS }),
    ).resolves.toBe(livePath);
  });

  it("accepts a session of nothing but session cookies, which carry no expiry to judge", async () => {
    const sessionOnlyPath = join(dir, "session-cookies.json");
    await writeFile(
      sessionOnlyPath,
      JSON.stringify({ cookies: [cookie(-1), cookie(-1)], origins: [] }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: sessionOnlyPath }, now: NOW_MS }),
    ).resolves.toBe(sessionOnlyPath);
  });
});

describe("isStorageStateExpired", () => {
  it("calls a state dead only when every cookie carrying an expiry is past it", () => {
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS - 1)] }, NOW_MS)).toBe(true);
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS)] }, NOW_MS)).toBe(true);
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS + 1)] }, NOW_MS)).toBe(false);
    expect(
      isStorageStateExpired({ cookies: [cookie(NOW_SECONDS - 1), cookie(NOW_SECONDS + 1)] }, NOW_MS),
    ).toBe(false);
  });

  it("judges only the cookies with a real expiry and ignores the rest", () => {
    // A negative value is Playwright's session-cookie marker. Zero and a non-number are not
    // expiry times either. A state that offers nothing to judge is never called dead.
    expect(isStorageStateExpired({ cookies: [cookie(-1)] }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [cookie(0)] }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [{ name: "s", value: "v" }] }, NOW_MS)).toBe(false);
    expect(
      isStorageStateExpired({ cookies: [cookie(-1), cookie(NOW_SECONDS - 1)] }, NOW_MS),
    ).toBe(true);
  });

  it("says nothing about a state with no cookies at all", () => {
    // A bearer token in origins[].localStorage has no expiry field, so this rule cannot see it.
    // The scan-time redirect check is what covers a session that dies without a dated cookie.
    expect(isStorageStateExpired({ cookies: [], origins: [] }, NOW_MS)).toBe(false);
    expect(
      isStorageStateExpired(
        { origins: [{ origin: "http://app.test", localStorage: [{ name: "jwt", value: "x" }] }] },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("says nothing about a shape it does not recognise", () => {
    expect(isStorageStateExpired(null, NOW_MS)).toBe(false);
    expect(isStorageStateExpired("cookies", NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: "none" }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [null, 7] }, NOW_MS)).toBe(false);
  });
});
