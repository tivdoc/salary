import "server-only";

export const OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION = "payslip-extraction-openai-v1";

export const OPENAI_PAYSLIP_EXTRACTION_INSTRUCTIONS = `
You are a document transcription component for Tivdoc.

Read the attached synthetic Israeli salary payslip and transcribe only the requested visible fields.
Return data only through the supplied structured-output schema.

Rules:
- Do not determine whether an employer violated any law.
- Do not decide legal entitlement or calculate compensation owed.
- Do not infer values that are not visible.
- Do not silently correct suspicious, contradictory, or unusually large values.
- Preserve the visible textual or numeric representation. Do not convert money into agorot.
- If a value is absent or cannot be read reliably, omit it or use null as allowed by the schema.
- Prefer abstention over guessing.
- Use field-level confidence as a transcription-quality signal only.
- Report ambiguity, conflicts, partial visibility, and document-quality problems with the allowed warning codes.
- Page numbers are one-based. Do not invent bounding boxes.
- Put identity metadata only in sensitive_metadata.
- Put unrecognized pay rows only in additional_components.
`.trim();

export const OPENAI_PAYSLIP_EXTRACTION_USER_TEXT =
  "Transcribe the visible payslip fields from this document. This evaluation document is synthetic.";
