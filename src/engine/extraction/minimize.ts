import { z } from "zod";
import { confidenceSchema, domainCodeSchema, moneySchema, uuidSchema } from "../domain/primitives";
import { boundingBoxSchema, detectedDocumentTypeSchema, payslipFieldKeySchema } from "./contracts";
import { normalizedPayslipExtractionSchema, normalizedPercentageSchema } from "./payslip";

const minimizedSourceSchema = z
  .object({
    document_id: uuidSchema,
    page: z.number().int().positive(),
    bounding_box: boundingBoxSchema.optional(),
  })
  .strict();

const minimizedValueSchema = z.union([
  z.string(),
  moneySchema,
  normalizedPercentageSchema,
  z.object({ amount: z.string(), unit: z.string() }).strict(),
  z.object({ year: z.number().int(), month: z.number().int(), start_date: z.string(), end_date: z.string() }).strict(),
]);

export const minimizedPayslipSchema = z
  .object({
    document_id: uuidSchema,
    detected_document_type: detectedDocumentTypeSchema,
    document_quality_confidence: confidenceSchema,
    fields: z.array(
      z
        .object({
          field: payslipFieldKeySchema,
          normalized_value: minimizedValueSchema,
          confidence: confidenceSchema,
          source: minimizedSourceSchema,
          warning_flags: z.array(domainCodeSchema),
        })
        .strict(),
    ),
    additional_components: z.array(
      z
        .object({
          normalized_label: domainCodeSchema.nullable(),
          semantic_kind: z.string(),
          quantity: z.string().nullable(),
          rate: moneySchema.nullable(),
          percentage: normalizedPercentageSchema.nullable(),
          amount: moneySchema.nullable(),
          confidence: confidenceSchema,
          source: minimizedSourceSchema,
          warning_flags: z.array(domainCodeSchema),
        })
        .strict(),
    ),
    warnings: z.array(domainCodeSchema),
  })
  .strict();

export function minimizePayslipForSemanticProcessing(input: unknown) {
  const extraction = normalizedPayslipExtractionSchema.parse(input);
  return minimizedPayslipSchema.parse({
    document_id: extraction.document_id,
    detected_document_type: extraction.detected_document_type,
    document_quality_confidence: extraction.document_quality_confidence,
    fields: extraction.fields
      .filter((field) => field.normalized_value !== null)
      .map((field) => ({
        field: field.field,
        normalized_value: field.normalized_value,
        confidence: field.confidence,
        source: {
          document_id: field.source.document_id,
          page: field.source.page,
          ...(field.source.bounding_box ? { bounding_box: field.source.bounding_box } : {}),
        },
        warning_flags: field.warning_flags,
      })),
    additional_components: extraction.additional_components.map((component) => ({
      normalized_label: component.normalized_label,
      semantic_kind: component.semantic_kind,
      quantity: component.quantity,
      rate: component.rate,
      percentage: component.percentage,
      amount: component.amount,
      confidence: component.confidence,
      source: {
        document_id: component.source.document_id,
        page: component.source.page,
        ...(component.source.bounding_box ? { bounding_box: component.source.bounding_box } : {}),
      },
      warning_flags: [...component.warning_flags, ...component.normalization_warnings],
    })),
    warnings: extraction.warnings,
  });
}
