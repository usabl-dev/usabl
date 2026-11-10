import { describe, expect, it } from "vitest";
import type { Finding, Receipt, UsablConfig, Waiver } from "../../src/contracts/index.js";
import { makeFakeDeps } from "../../src/deps/fakes.js";
import {
  earliestAppliedWaiverExpiry,
  mintReceipt,
  receiptFailureReasons,
  verifyReceipt,
} from "../../src/evidence/receipt.js";

// A receipt minted while a waiver was live must stop verifying once that waiver ends, because the
// gate would then count the waived barrier again. These tests hold the binding and the check.

const config: UsablConfig = {
  appBaseUrl: "http://127.0.0.1:5173",
  uiFileGlobs: ["src/**/*.tsx"],
  discovery: { routerFile: "src/router.tsx", wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ["usabl.config.json"],
};

const MINTED = "2026-03-01T00:00:00.000Z";
const EXPIRES = "2026-06-01T00:00:00.000Z";
const BEFORE = "2026-05-31T23:59:59.999Z";
const AFTER = "2026-06-01T00:00:00.001Z";

function deps(now: string) {
  const files = { "usabl.config.json": "{}" };
  return makeFakeDeps({ now, files, headContents: files, headBlobs: { "usabl.config.json": "blob-config" }, writeTree: "tree-a" });
}

const mintArgs = {
  surfaces: ["cli"],
  checked: ["clusters"],
  notCovered: [],
  applicability: [],
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
};

function waiver(over: Partial<Waiver>): Waiver {
  return {
    rule: "color-contrast",
    surface: "clusters",
    scope: "*",
    reason: "tracked",
    owner: "team",
    approvedBy: "owner",
    created: "2026-01-01T00:00:00.000Z",
    expires: EXPIRES,
    ...over,
  };
}

function finding(over: Partial<Finding>): Finding {
  return {
    rule: "color-contrast",
    layer: "axe",
    severity: "serious",
    evidenceClass: "deterministic",
    screenId: "clusters",
    elementPath: "button",
    elementName: "Save",
    role: "button",
    whatUserExperiences: "Save is hard to read",
    why: "contrast too low",
    fix: "Increase contrast",
    evidence: {},
    confidence: "fail",
    elementKey: "button-save",
    identityBasis: "name",
    status: "waived",
    ...over,
  } as Finding;
}

describe("earliestAppliedWaiverExpiry", () => {
  it("binds nothing when no finding was waived", () => {
    expect(earliestAppliedWaiverExpiry([finding({ status: "new" })], [waiver({})], MINTED)).toBeNull();
    expect(earliestAppliedWaiverExpiry([], [], MINTED)).toBeNull();
  });

  it("binds the earliest expiry among the waivers that waived a finding", () => {
    const findings = [
      finding({ rule: "color-contrast" }),
      finding({ rule: "button-name", elementKey: "k2" }),
    ];
    const waivers = [
      waiver({ rule: "color-contrast", expires: "2026-09-01T00:00:00.000Z" }),
      waiver({ rule: "button-name", scope: "k2", expires: EXPIRES }),
    ];
    expect(earliestAppliedWaiverExpiry(findings, waivers, MINTED)).toBe(EXPIRES);
    // The order of the ledger does not change the answer.
    expect(earliestAppliedWaiverExpiry(findings, [...waivers].reverse(), MINTED)).toBe(EXPIRES);
  });

  it("does not bind a live waiver that waived nothing, nor an expired one", () => {
    const findings = [finding({})];
    const waivers = [
      waiver({ expires: "2026-09-01T00:00:00.000Z" }),
      // Matches nothing on this run, so its end changes nothing.
      waiver({ rule: "image-alt", expires: "2026-04-01T00:00:00.000Z" }),
      // Already over when the run read the clock, so the gate ignored it.
      waiver({ expires: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(earliestAppliedWaiverExpiry(findings, waivers, MINTED)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("binds the earliest live waiver when a waived finding matches none of them", () => {
    // The gate decided the waiver match. If a waived finding is not explained by the match rule
    // here, the binding falls back to every live waiver, which can only bind an earlier time.
    const findings = [finding({ rule: "landmark-one-main", elementKey: null })];
    const waivers = [
      waiver({ rule: "image-alt", expires: "2026-04-01T00:00:00.000Z" }),
      waiver({ rule: "color-contrast", expires: EXPIRES }),
    ];
    expect(earliestAppliedWaiverExpiry(findings, waivers, MINTED)).toBe("2026-04-01T00:00:00.000Z");
  });

  it("binds the run's own time when a finding is waived and no waiver was live", () => {
    expect(earliestAppliedWaiverExpiry([finding({})], [], MINTED)).toBe(MINTED);
  });
});

describe("a receipt ends when a waiver it used ends", () => {
  it("records the expiry it was given", async () => {
    const receipt = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 1, waiverExpiresAt: EXPIRES });
    expect(receipt.waiverExpiresAt).toBe(EXPIRES);
  });

  it("records null when no waiver applied", async () => {
    const receipt = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 0 });
    expect(receipt.waiverExpiresAt).toBeNull();
  });

  it("verifies before the expiry and not at or after it", async () => {
    const receipt = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 1, waiverExpiresAt: EXPIRES });

    await expect(verifyReceipt(deps(BEFORE), config, receipt, "tree-a")).resolves.toMatchObject({
      valid: true,
      failedFields: [],
    });
    for (const now of [EXPIRES, AFTER]) {
      const verification = await verifyReceipt(deps(now), config, receipt, "tree-a");
      expect(verification.valid).toBe(false);
      expect(verification.failedFields).toEqual(["waiverExpiresAt"]);
      const reasons = receiptFailureReasons(receipt, verification.failedFields, now);
      expect(reasons).toEqual([
        `a waiver this receipt relied on ended at ${EXPIRES}, so the accessibility barrier it waived counts again`,
      ]);
    }
  });

  it("keeps verifying with no waiver, whatever the clock says", async () => {
    const receipt = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 0 });
    await expect(verifyReceipt(deps("2099-01-01T00:00:00.000Z"), config, receipt, "tree-a")).resolves.toMatchObject({
      valid: true,
    });
  });

  it("does not verify a receipt from before the binding that counted a waiver", async () => {
    const minted = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 0 });
    const old: Record<string, unknown> = { ...minted, activeWaivers: 2 };
    delete old["waiverExpiresAt"];
    const verification = await verifyReceipt(deps(BEFORE), config, old as unknown as Receipt, "tree-a");
    expect(verification.valid).toBe(false);
    expect(verification.failedFields).toEqual(["waiverExpiresAt"]);
  });

  it("still verifies a receipt from before the binding that counted no waiver", async () => {
    const minted = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 0 });
    const old: Record<string, unknown> = { ...minted };
    delete old["waiverExpiresAt"];
    await expect(verifyReceipt(deps(BEFORE), config, old as unknown as Receipt, "tree-a")).resolves.toMatchObject({
      valid: true,
    });
  });

  it("does not verify a receipt whose waiver count and expiry disagree or whose expiry is not a time", async () => {
    const minted = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 0 });
    const cases: Array<Record<string, unknown>> = [
      { ...minted, activeWaivers: 1, waiverExpiresAt: null },
      { ...minted, activeWaivers: 1, waiverExpiresAt: "never" },
      { ...minted, activeWaivers: 0, waiverExpiresAt: "2026-06-01" },
      { ...minted, activeWaivers: 1, waiverExpiresAt: 1780272000000 },
    ];
    for (const receipt of cases) {
      const verification = await verifyReceipt(deps(BEFORE), config, receipt as unknown as Receipt, "tree-a");
      expect(verification.valid).toBe(false);
      expect(verification.failedFields).toEqual(["waiverExpiresAt"]);
    }
  });

  it("does not verify a bound expiry against a clock that is not a time", async () => {
    const receipt = await mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 1, waiverExpiresAt: EXPIRES });
    const verification = await verifyReceipt(deps(""), config, receipt, "tree-a");
    expect(verification.valid).toBe(false);
    expect(verification.failedFields).toEqual(["waiverExpiresAt"]);
  });

  it("refuses to mint a receipt that counts a waiver but binds no expiry", async () => {
    await expect(mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 1 })).rejects.toThrow(
      /waiverExpiresAt/,
    );
    await expect(
      mintReceipt(deps(MINTED), config, { ...mintArgs, activeWaivers: 1, waiverExpiresAt: "soon" }),
    ).rejects.toThrow(/waiverExpiresAt/);
  });
});
