import { z } from "zod";
import {
  confidenceSchema,
  domainCodeSchema,
  versionSchema,
} from "../domain/primitives.ts";
import { factPathSchema } from "../facts/fact-paths.ts";
import { KNOWN_UNIT_IDS } from "../legal-operations/units.ts";
import { sha256Schema } from "../legal-knowledge/contracts.ts";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";

const syntheticFactPathSchema = z
  .string()
  .regex(/^synthetic\.[a-z0-9]+(?:[._:-][a-z0-9]+)*$/)
  .max(160);

export const ruleInputTransformationRefSchema = z
  .object({
    transformation_id: domainCodeSchema,
    transformation_version: versionSchema,
  })
  .strict()
  .readonly();

export const ruleInputMappingSchema = z
  .object({
    input_id: domainCodeSchema,
    runtime_fact_path: syntheticFactPathSchema,
    fact_path: factPathSchema,
    minimum_confidence: confidenceSchema,
    max_age_seconds: z.number().int().nonnegative().max(31_536_000),
    // L7-2 / D2 (registry v2): beside the decimal and money kinds, an input
    // may be typed by the executor's own unit registry — a rational in
    // `hours`, `months` or `ratio`, an integer in `count.years`, `days` or
    // `hours` — so a mapping says what the spec's slot consumes, in the
    // spec's terms, and a transformation that cannot produce it refuses.
    expected_output: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("decimal"),
          unit: domainCodeSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("money"),
          currency: z.string().regex(/^[A-Z]{3}$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal("rational"),
          unit: z.enum(KNOWN_UNIT_IDS),
        })
        .strict(),
      z
        .object({
          kind: z.literal("integer"),
          unit: z.enum(KNOWN_UNIT_IDS),
        })
        .strict(),
    ]),
    transformation: ruleInputTransformationRefSchema,
  })
  .strict()
  .readonly();

export const ruleInputMappingRegistrySchema = z
  .object({
    registry_id: domainCodeSchema,
    registry_version: versionSchema,
    mappings: z.array(ruleInputMappingSchema).min(1).readonly(),
  })
  .strict()
  .superRefine((registry, context) => {
    const inputIds = new Set<string>();
    const runtimePaths = new Set<string>();
    const factPaths = new Set<string>();
    for (const [index, mapping] of registry.mappings.entries()) {
      if (inputIds.has(mapping.input_id)) {
        context.addIssue({ code: "custom", message: "mapping_input_id_duplicate", path: ["mappings", index] });
      }
      if (runtimePaths.has(mapping.runtime_fact_path)) {
        context.addIssue({ code: "custom", message: "mapping_runtime_fact_path_duplicate", path: ["mappings", index] });
      }
      if (factPaths.has(mapping.fact_path)) {
        context.addIssue({ code: "custom", message: "mapping_fact_path_duplicate", path: ["mappings", index] });
      }
      inputIds.add(mapping.input_id);
      runtimePaths.add(mapping.runtime_fact_path);
      factPaths.add(mapping.fact_path);
    }
  })
  .readonly();

export const registeredRuleInputMappingRegistrySchema = z
  .object({
    registry: ruleInputMappingRegistrySchema,
    registry_sha256: sha256Schema,
  })
  .strict()
  .readonly();

export type RuleInputTransformationRef = z.infer<typeof ruleInputTransformationRefSchema>;
export type RuleInputMapping = z.infer<typeof ruleInputMappingSchema>;
export type RuleInputMappingRegistry = z.infer<typeof ruleInputMappingRegistrySchema>;
export type RegisteredRuleInputMappingRegistry = z.infer<
  typeof registeredRuleInputMappingRegistrySchema
>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function registerRuleInputMappingRegistry(
  candidate: RuleInputMappingRegistry,
): RegisteredRuleInputMappingRegistry {
  const parsed = ruleInputMappingRegistrySchema.parse(candidate);
  const registry = ruleInputMappingRegistrySchema.parse({
    ...parsed,
    mappings: [...parsed.mappings].sort((left, right) =>
      compareStrings(left.input_id, right.input_id),
    ),
  });
  return deepFreeze(
    registeredRuleInputMappingRegistrySchema.parse({
      registry,
      registry_sha256: canonicalSha256(registry),
    }),
  );
}
