import path from "node:path";

export const CUSTOMER_PAYSLIP_REDACTION_V2 = "customer-payslip-redaction-v2";

export type RedactionRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type SensitiveSignal =
  | "address"
  | "bank_details"
  | "direct_identifier"
  | "employee_number"
  | "email"
  | "national_id"
  | "phone"
  | "qr_or_barcode"
  | "signature";

export type RedactionVerificationFailure = Readonly<{
  code: string;
  message: string;
}>;

export type CustomerRedactionVerification = Readonly<{
  passed: boolean;
  failures: readonly RedactionVerificationFailure[];
}>;

function addFailure(
  failures: RedactionVerificationFailure[],
  condition: boolean,
  code: string,
  message: string,
) {
  if (condition) failures.push({ code, message });
}

function isInsideRoot(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function contains(container: RedactionRectangle, target: RedactionRectangle, margin: number) {
  return container.x <= target.x - margin &&
    container.y <= target.y - margin &&
    container.x + container.width >= target.x + target.width + margin &&
    container.y + container.height >= target.y + target.height + margin;
}

function overlaps(left: RedactionRectangle, right: RedactionRectangle) {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

const piiKeywordSignals: readonly Readonly<{ signal: SensitiveSignal; pattern: RegExp }>[] = [
  { signal: "address", pattern: /(?:כתובת|address)/iu },
  { signal: "bank_details", pattern: /(?:חשבון\s*בנק|סניף|bank\s*account|bank\s*branch)/iu },
  { signal: "employee_number", pattern: /(?:מס(?:פר|['׳])?\s*עובד|employee\s*(?:number|id))/iu },
  { signal: "signature", pattern: /(?:חתימה|signature)/iu },
];

export function detectSensitiveTextSignals(text: string): readonly SensitiveSignal[] {
  const signals = new Set<SensitiveSignal>();
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)) signals.add("email");
  if (/(?<!\d)0(?:5\d[- ]?\d{7}|[23489][- ]?\d{7})(?!\d)/u.test(text)) signals.add("phone");
  if (/(?<!\d)\d{9}(?!\d)/u.test(text)) signals.add("national_id");
  for (const entry of piiKeywordSignals) {
    if (entry.pattern.test(text)) signals.add(entry.signal);
  }
  return [...signals].sort();
}

export function verifyCustomerRedactionV2(input: Readonly<{
  neutralDocumentId: string;
  artifactFilename: string;
  artifactPath: string;
  approvedRedactedRoot: string;
  artifactMimeType: string;
  pipelineVersion: string;
  sourceSha256: string;
  artifactSha256: string;
  isSymlinkOrReference: boolean;
  metadataEntries: Readonly<Record<string, string>>;
  extractedHiddenText: string;
  detectedSignals: readonly SensitiveSignal[];
  knownSensitiveRegions: readonly RedactionRectangle[];
  opaqueMaskRegions: readonly RedactionRectangle[];
  retainedRegions: readonly RedactionRectangle[];
  serializedManifest: string;
  maskSafetyMargin: number;
}>): CustomerRedactionVerification {
  const failures: RedactionVerificationFailure[] = [];
  const expectedFilename = `${input.neutralDocumentId}.png`;
  addFailure(failures, !/^CUSTOMER_EVAL_00[1-5]$/.test(input.neutralDocumentId), "invalid_neutral_id", "Document ID is not neutral.");
  addFailure(failures, input.artifactFilename !== expectedFilename, "non_neutral_filename", "Artifact filename is not the neutral ID.");
  addFailure(failures, !isInsideRoot(input.artifactPath, input.approvedRedactedRoot), "artifact_outside_approved_root", "Artifact is outside the V2 redacted root.");
  addFailure(failures, input.isSymlinkOrReference, "source_reference_detected", "Artifact resolves through a link or source reference.");
  addFailure(failures, input.pipelineVersion !== CUSTOMER_PAYSLIP_REDACTION_V2, "obsolete_redaction_pipeline", "Artifact was not produced by Redaction V2.");
  addFailure(failures, input.artifactMimeType !== "image/png", "non_raster_artifact", "Only flattened PNG artifacts are accepted.");
  addFailure(failures, input.sourceSha256 === input.artifactSha256, "artifact_matches_source", "Artifact bytes match the original source.");
  addFailure(failures, input.extractedHiddenText.trim().length > 0, "hidden_text_present", "Artifact contains a recoverable text layer.");
  addFailure(failures, Object.keys(input.metadataEntries).length > 0, "identifying_metadata_present", "Artifact contains metadata.");
  addFailure(failures, input.detectedSignals.length > 0, "sensitive_pattern_detected", "Local detectors found a sensitive signal.");

  for (const [index, sensitive] of input.knownSensitiveRegions.entries()) {
    addFailure(
      failures,
      !input.opaqueMaskRegions.some((mask) => contains(mask, sensitive, input.maskSafetyMargin)),
      "sensitive_region_not_covered",
      `Known sensitive region ${index} is not covered with the required margin.`,
    );
    addFailure(
      failures,
      input.retainedRegions.some((region) => overlaps(region, sensitive)),
      "allowlist_overlaps_sensitive_region",
      `Retained region overlaps known sensitive region ${index}.`,
    );
  }

  const serializedLeak = /(?:[A-Za-z]:[\\/](?:Users|Documents|OneDrive)[\\/]|original[_ -]?filename|source[_ -]?path|employee[_ -]?name)/iu;
  addFailure(failures, serializedLeak.test(input.serializedManifest), "source_path_or_identity_leak", "Manifest contains a source path or identity key.");
  return { passed: failures.length === 0, failures };
}
