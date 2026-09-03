import { describe, expect, it } from "vitest";
import type {
  AffectedScreen,
  Coverage,
  DocsSourceMapping,
  Finding,
} from "../../src/contracts/index.js";
import {
  enrichAppFindings,
  mapFindingToAppSource,
} from "../../src/app/source-map.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    rule: "color-contrast",
    layer: "axe",
    severity: "serious",
    evidenceClass: "deterministic",
    screenId: "clusters",
    elementPath: "button",
    elementName: "Save",
    role: "button",
    whatUserExperiences: "Low contrast",
    why: "ratio 2:1",
    fix: "Raise to 4.5:1",
    evidence: {},
    confidence: "fail",
    status: "new",
    identityBasis: "name",
    elementKey: "clusters|color-contrast|name:save",
    ...over,
  };
}

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    affected: [
      {
        screenId: "clusters",
        url: "http://127.0.0.1:5173/clusters",
        provenance: "manual",
      },
    ],
    changedFiles: ["fixtures/app/src/ClustersPage.tsx"],
    gaps: [],
    nothingToCheck: false,
    unresolvedFiles: [],
    ...over,
  };
}

function screen(over: Partial<AffectedScreen> = {}): AffectedScreen {
  return {
    screenId: "clusters",
    url: "http://127.0.0.1:5173/clusters",
    provenance: "manual",
    ...over,
  };
}

describe("mapFindingToAppSource", () => {
  it("chooses renderer tier when data-source attrs are present", () => {
    const mapped = mapFindingToAppSource(
      finding({
        evidence: {
          extra: {
            html: '<button data-source-file="src/pages/Clusters.tsx" data-source-line="12">Save</button>',
          },
        },
      }),
      coverage(),
      screen(),
    );

    expect(mapped).toEqual({
      tier: "renderer",
      file: "src/pages/Clusters.tsx",
      line: 12,
      candidates: ["src/pages/Clusters.tsx"],
    });
  });

  it("chooses import-chain tier and prefers the leaf changed file on the route path", () => {
    const mapped = mapFindingToAppSource(
      finding(),
      coverage(),
      screen({
        importChain: [
          "src/layouts/AppShell.tsx",
          "src/pages/Clusters.tsx",
        ],
      }),
    );

    expect(mapped).toEqual({
      tier: "import-chain",
      file: "src/pages/Clusters.tsx",
      line: null,
      candidates: ["src/layouts/AppShell.tsx", "src/pages/Clusters.tsx"],
    });
  });

  it("attributes coverage tier when exactly one changed UI file applies to the screen", () => {
    const mapped = mapFindingToAppSource(finding(), coverage(), screen());

    expect(mapped).toEqual({
      tier: "coverage",
      file: "fixtures/app/src/ClustersPage.tsx",
      line: null,
      candidates: ["fixtures/app/src/ClustersPage.tsx"],
    });
  });

  it("leaves file null on a wide-blast screen with several changed files", () => {
    const mapped = mapFindingToAppSource(
      finding(),
      coverage({
        changedFiles: [
          "fixtures/app/src/ClustersPage.tsx",
          "fixtures/app/src/DemoControls.tsx",
        ],
      }),
      screen({ provenance: "wide-blast" }),
    );

    expect(mapped?.tier).toBe("coverage");
    expect(mapped?.file).toBeNull();
    expect(mapped?.candidates).toEqual([
      "fixtures/app/src/ClustersPage.tsx",
      "fixtures/app/src/DemoControls.tsx",
    ]);
  });

  it("returns null when no changed files apply to the screen", () => {
    const mapped = mapFindingToAppSource(
      finding(),
      coverage({ changedFiles: [] }),
      screen(),
    );

    expect(mapped).toBeNull();
  });

  it("returns null for docs findings", () => {
    const docsSource: DocsSourceMapping = {
      tier: "content",
      file: "modules/proc_create.adoc",
      line: null,
      construct: "image::create.png[]",
      candidates: ["modules/proc_create.adoc"],
      fix: "Add alt text",
    };
    const mapped = mapFindingToAppSource(
      finding({ docsSource }),
      coverage(),
      screen(),
    );

    expect(mapped).toBeNull();
  });
});

describe("enrichAppFindings", () => {
  it("leaves docs findings untouched and attaches appSource only to app findings", () => {
    const docsSource: DocsSourceMapping = {
      tier: "content",
      file: "modules/proc_create.adoc",
      line: null,
      construct: null,
      candidates: ["modules/proc_create.adoc"],
      fix: "Add alt text",
    };
    const enriched = enrichAppFindings(
      [
        finding({ docsSource }),
        finding({ screenId: "clusters" }),
      ],
      coverage(),
    );
    const docsFinding = enriched[0];
    const appFinding = enriched[1];

    expect(docsFinding?.docsSource).toBe(docsSource);
    expect(docsFinding?.appSource).toBeUndefined();
    expect(appFinding?.appSource?.tier).toBe("coverage");
  });
});
