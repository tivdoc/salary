// Pool P batch 17 (run 11, L11-3 / D3.1). The average wage, twice, by name.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-17-average-wage.mts
//
// The National Insurance Institute publishes the average wage under two
// sections of the National Insurance Law, and from 1.1.2026 they differ:
// §1 (the base of the monthly minimum wage, Minimum Wage Law §6: 47.5% of the
// average wage per §1) stands at 13,566, §2 "לעניין גמלאות" (benefits) at
// 13,769. Until now the two figures lived only inside the pension cap's two
// decision branches. The lawyer-approved opinion (5.9.2026) resolved that
// decision to the §2 benefits figure and asked for the two averages to be
// parameters of their own, each with its own citation, so that the
// minimum-wage draft binds the §1 figure and the pension draft binds the §2
// figure by name rather than by implication.
//
//   il.average_wage.nii_s1@2026.1.0            13,566 ILS  §1, minimum-wage base
//   il.average_wage.nii_s2_benefits@2026.1.0   13,769 ILS  §2 benefits, pension cap source
//
// Both cite the same official page chunk the cap's branches cite, at the
// text_verified grade, with the section named in Hebrew in the needle. Both
// are draft; nothing here is attested, reviewed or active.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, citation, importPoolPBatch, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const D2 = { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const AVERAGE_WAGE_CHUNK = "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0002-00fe06cb93a9";

const section1 = buildCandidate({
  parameter_id: "il.average_wage.nii_s1",
  parameter_version: "2026.1.0",
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: 1_356_600 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["official_implementation"],
  citations: [citation(D2, AVERAGE_WAGE_CHUNK,
    "Average wage per National Insurance Law §1 (לפי סעיף 1 בחוק — קצבאות / דמי ביטוח), from 1.1.2026: 13,566 ILS. The base of the monthly minimum wage under Minimum Wage Law §6 (47.5% of the average wage per §1). Registered as its own parameter (run 11, D3.1) so the minimum-wage draft binds the §1 figure by name.",
    ["סעיף 1", "13,566"])],
});

const section2Benefits = buildCandidate({
  parameter_id: "il.average_wage.nii_s2_benefits",
  parameter_version: "2026.1.0",
  topic: "pension",
  value: { kind: "money", value: { currency: "ILS", minor_units: 1_376_900 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["official_implementation"],
  citations: [citation(D2, AVERAGE_WAGE_CHUNK,
    "Average wage per National Insurance Law §2, benefits (לפי סעיף 2 בחוק — קצבאות), from 1.1.2026: 13,769 ILS. The figure the lawyer-approved opinion (5.9.2026, owner-recorded resolution pension_wage_cap_source → section2) identifies as the source of the mandatory-pension wage cap. Registered as its own parameter (run 11, D3.1) so the pension draft binds the §2 benefits figure by name, beside the cap's own decision branches.",
    ["סעיף 2", "13,769"])],
});

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const candidates = [section1, section2Benefits];
  await importPoolPBatch("batch-17-average-wage", candidates);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-17-v1",
    unit: "L11-3 / D3.1",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    candidate_sha256: Object.fromEntries(candidates.map((entry) => [`${entry.parameter_id}@${entry.parameter_version}`, entry.candidate_sha256])),
    provenance_grade: "text_verified",
    chunk_cited: AVERAGE_WAGE_CHUNK,
    bound_by: {
      "il.average_wage.nii_s1@2026.1.0": "rulespec.draft.minimum_wage (slot.minimum_wage.average_wage_base)",
      "il.average_wage.nii_s2_benefits@2026.1.0": "rulespec.draft.pension (slot.pension.average_wage_benefits)",
    },
    state: "draft",
    attestations: 0,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-17-average-wage.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_3_BATCH17 ${JSON.stringify({ registered: candidates.length, grade: "text_verified" })}`);
}

await main();
