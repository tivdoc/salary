import { z } from "zod";
import { calculationTraceSchema } from "../calculations/contracts.ts";
import {
  confidenceSchema,
  dateRangeSchema,
  domainCodeSchema,
  isoTimestampSchema,
  nonNegativeMoneySchema,
  uuidSchema,
} from "../domain/primitives.ts";
import { evidenceReferenceSchema } from "../facts/contracts.ts";
import { ruleReferenceSchema } from "../rules/contracts.ts";
import {sourceCalculationTraceSchema} from '../calculations/source-trace.ts';
import {sourceMonetaryComparisonV2Schema} from './source-comparison.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';

export const findingStatusSchema = z.enum([
  "candidate",
  "needs_confirmation",
  "verified",
  "rejected",
  "blocked",
]);

export const confidenceTierSchema = z.enum(["low", "medium", "high"]);

export const findingV1Schema = z
  .object({
    finding_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    category: domainCodeSchema,
    status: findingStatusSchema,
    period: dateRangeSchema.nullable(),
    paid: nonNegativeMoneySchema.nullable(),
    expected: nonNegativeMoneySchema.nullable(),
    potential_gap: nonNegativeMoneySchema.nullable(),
    confidence: confidenceSchema,
    confidence_tier: confidenceTierSchema,
    fact_references: z.array(uuidSchema).min(1),
    evidence_references: z.array(evidenceReferenceSchema).min(1),
    rule: ruleReferenceSchema,
    calculation_trace: calculationTraceSchema.nullable(),
    requires_confirmation: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((finding, context) => {
    const moneyValues = [finding.paid, finding.expected, finding.potential_gap].filter(
      (money): money is NonNullable<typeof money> => money !== null,
    );
    const monetary = moneyValues.length > 0;
    if (new Set(moneyValues.map((money) => money.currency)).size > 1) {
      context.addIssue({
        code: "custom",
        message: "All monetary values in a finding must use the same currency",
        path: ["potential_gap"],
      });
    }

    if ((finding.expected !== null || finding.potential_gap !== null) && finding.calculation_trace === null) {
      context.addIssue({
        code: "custom",
        message: "Expected amounts and potential gaps require a deterministic calculation trace",
        path: ["calculation_trace"],
      });
    }

    if (
      finding.calculation_trace !== null &&
      (finding.calculation_trace.rule.rule_id !== finding.rule.rule_id ||
        finding.calculation_trace.rule.rule_version !== finding.rule.rule_version)
    ) {
      context.addIssue({
        code: "custom",
        message: "The calculation trace must use the finding's rule version",
        path: ["calculation_trace", "rule"],
      });
    }

    const hasDirectSupport = finding.evidence_references.some(
      (reference) => reference.source_type === "documented" || reference.source_type === "declared",
    );
    if (monetary && !hasDirectSupport) {
      if (
        finding.status !== "needs_confirmation" ||
        finding.confidence_tier !== "low" ||
        !finding.requires_confirmation
      ) {
        context.addIssue({
          code: "custom",
          message: "Inference-only monetary findings must remain low-confidence and require confirmation",
          path: ["evidence_references"],
        });
      }
    }

    if (finding.status === "verified" && finding.requires_confirmation) {
      context.addIssue({
        code: "custom",
        message: "A verified finding cannot still require confirmation",
        path: ["requires_confirmation"],
      });
    }
  });

/** Versioned source-backed findings do not reinterpret historical traces or
 * change the comparison's arithmetic-only/is_finding=false contract. Legal
 * authority is a separate exact verified receipt carried by this finding. */
export const findingV2Schema=z.object({
 ...findingV1Schema.shape,
 schema_version:z.literal('tivdoc-source-finding-v2'),
 calculation_trace:sourceCalculationTraceSchema,
 comparison:sourceMonetaryComparisonV2Schema,
 authority:z.object({namespace:z.enum(['real','isolated_test']),authority_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  admission_sha256:z.string().regex(/^[a-f0-9]{64}$/u),assessment_envelope_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  real_legal_authority:z.boolean(),human_report_approval:z.literal(false)}).strict(),
}).strict().superRefine((finding,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const t=finding.calculation_trace,c=finding.comparison;
 if(t.case_id!==finding.case_id||t.analysis_run_id!==finding.analysis_run_id||canonicalSha256(t)!==canonicalSha256(c.trace))fail('FINDING_SOURCE_RUN_BINDING');
 if(finding.rule.rule_id!==t.rule.rule_id||finding.rule.rule_version!==t.rule.rule_version)fail('FINDING_SOURCE_RULE_BINDING');
 if(c.signed_difference.minor_units<=0||canonicalSha256(finding.expected)!==canonicalSha256(c.expected)
  ||canonicalSha256(finding.paid)!==canonicalSha256(c.recorded)||canonicalSha256(finding.potential_gap)!==canonicalSha256(c.signed_difference))fail('FINDING_SOURCE_AMOUNT_BINDING');
 const bound=t.inputs.filter(i=>i.source.kind==='fact').map(i=>i.source.kind==='fact'?i.source.fact_id:'');
 if(new Set(finding.fact_references).size!==finding.fact_references.length||bound.some(id=>!finding.fact_references.includes(id))
  ||finding.fact_references.some(id=>!t.facts_snapshot.facts.some(f=>f.fact_id===id)))fail('FINDING_SOURCE_FACT_BINDING');
 const actualEvidence=t.facts_snapshot.facts.filter(f=>finding.fact_references.includes(f.fact_id)).flatMap(f=>f.provenance);
 if(finding.evidence_references.some(e=>!actualEvidence.some(a=>canonicalSha256(a)===canonicalSha256(e)))
  ||!finding.evidence_references.some(e=>e.source_type==='documented'))fail('FINDING_SOURCE_EVIDENCE_BINDING');
 if(finding.authority.real_legal_authority!==(finding.authority.namespace==='real'))fail('FINDING_AUTHORITY_NAMESPACE');
 if(finding.status==='verified'&&(finding.requires_confirmation||!finding.authority.real_legal_authority))fail('FINDING_VERIFICATION_AUTHORITY');
});
export const findingSchema=z.union([findingV1Schema,findingV2Schema]);
export type Finding = Readonly<z.infer<typeof findingSchema>>;
export type SourceFinding=Readonly<z.infer<typeof findingV2Schema>>;
