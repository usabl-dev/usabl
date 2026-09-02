/**
 * The session resolver decides whether a run scans signed in or signed out, so its rules are
 * held here directly rather than only through buildDeps. Two of them are honesty rules: an
 * empty variable is not a session, and a path usabl cannot read stops the run instead of
 * quietly producing a signed-out scan that still mints a verdict (issue #152). Messages are
 * asserted to exclude the path, because the path can name a private location and the file it
 * names holds live session tokens.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStorageStateEnv,
  resolveStorageStatePath,
  STORAGE_STATE_ENV_VAR,
} from "../../src/deps/session.js";

const VALID_STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

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
});
