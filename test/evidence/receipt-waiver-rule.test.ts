import { describe, expect, it, vi } from "vitest";
import type { Finding, Waiver } from "../../src/contracts/index.js";

// The receipt binds the end of the waivers the gate applied, so it must use the gate's own match
// rule, not a copy that can drift from it. Here the gate's rule is replaced by a different one
// (scope as a prefix). If the receipt follows it, it calls the gate. If it holds its own copy, the
// copy misses the waiver and the result differs.
vi.mock("../../src/gate/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/gate/index.js")>();
  return {
    ...real,
    waiverMatchesFinding: (waiver: Waiver, finding: Finding) =>
      waiver.rule === finding.rule &&
      waiver.surface === finding.screenId &&
      finding.elementKey !== null &&
      finding.elementKey.startsWith(waiver.scope),
  };
});

const { earliestAppliedWaiverExpiry } = await import("../../src/evidence/receipt.js");
const { waiverMatchesFinding } = await import("../../src/gate/index.js");

const NOW = "2026-03-01T00:00:00.000Z";

function waiver(over: Partial<Waiver>): Waiver {
  return {
    rule: "color-contrast",
    surface: "clusters",
    scope: "*",
    reason: "tracked",
    owner: "team",
    approvedBy: "owner",
    created: "2026-01-01T00:00:00.000Z",
    expires: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function waived(): Finding {
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
  } as Finding;
}

describe("the receipt uses the gate's waiver match rule", () => {
  it("binds the end of the waiver the gate's rule matched", () => {
    // Only the replaced rule matches the prefix scope. A waiver on another rule ends earlier and
    // matches nothing. A copy of the old rule would miss the prefix waiver, find the waived finding
    // unexplained, and bind the earliest live end instead.
    const prefix = waiver({ scope: "button-", expires: "2026-09-01T00:00:00.000Z" });
    const other = waiver({ rule: "label", expires: "2026-04-01T00:00:00.000Z" });
    expect(waiverMatchesFinding(prefix, waived())).toBe(true);
    expect(earliestAppliedWaiverExpiry([waived()], [other, prefix], NOW)).toBe("2026-09-01T00:00:00.000Z");
  });
});
