import { describe, expect, it } from "vitest";
import { buildCanonicalReachabilityReport } from "./reachability.ts";

describe("Wave 2.1 canonical reachability audit", () => {
  it("detects the V0.4 parallel gates and proves the controlled parser runtime canary", async () => {
    const report = await buildCanonicalReachabilityReport(process.cwd());
    expect(report.blocking_finding_count).toBe(3);
    expect(report.runtime_probes).toMatchObject({
      active_retrieval_unknown_sector_fail_closed: true,
      strict_readiness_seven_topics_fail_closed: true,
      controlled_import_parser_network_canary: { status: "network_canary", network_disabled: true },
    });
    expect(report.target_reachability.find((entry) => entry.target.endsWith("parser-isolation/index.ts"))?.reachable_from)
      .toContain("src/server/engine/legal-knowledge/controlled-import-security.ts");
    expect(report.target_reachability.find((entry) => entry.target.endsWith("container-segmentation.ts"))?.reachable_from).toEqual([]);
  }, 30_000);
});
