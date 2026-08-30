const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;

const PRIVACY_PATTERNS: readonly Readonly<{ code: string; pattern: RegExp }>[] = [
  { code: "EMAIL", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: "PHONE", pattern: /(?:\+?972[-\s]?|0)5\d(?:[-\s]?\d){7}\b/ },
  { code: "ID_NUMBER", pattern: /\b\d{9}\b/ },
  { code: "JWT", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { code: "SIGNED_URL", pattern: /https?:\/\/\S+(?:signature|token|x-amz-|x-goog-)[^\s]*/i },
  { code: "OBJECT_PATH", pattern: /(?:[A-Za-z]:\\|\/objects\/|\.\.\/)/ },
  { code: "AMOUNT_OR_SALARY", pattern: /(?:salary|gross|net|amount|₪|שכר)/i },
  { code: "OCR_TEXT", pattern: /(?:raw[_ -]?ocr|payslip|תלוש)/i },
];

export function scanPrivacyCanaries(value: unknown, explicitCanaries: readonly string[] = []): Readonly<{ safe: boolean; violation_codes: readonly string[] }> {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const violations = PRIVACY_PATTERNS.filter(({ pattern }) => pattern.test(serialized)).map(({ code }) => code);
  if (explicitCanaries.some((canary) => canary.length > 0 && serialized.includes(canary))) violations.push("EXPLICIT_CANARY");
  return Object.freeze({ safe: violations.length === 0, violation_codes: Object.freeze([...new Set(violations)].sort()) });
}

export function assertSafeOperationalRecord(record: Readonly<Record<string, unknown>>): void {
  const allowedKeys = new Set(["schema_version", "event", "status", "code", "opaque_id", "correlation_id", "sha256", "sequence", "timestamp"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new Error("OPERATIONAL_FIELD_FORBIDDEN");
  if (typeof record.opaque_id === "string" && !OPAQUE.test(record.opaque_id)) throw new Error("OPERATIONAL_OPAQUE_ID_INVALID");
  if (typeof record.correlation_id === "string" && !OPAQUE.test(record.correlation_id)) throw new Error("OPERATIONAL_CORRELATION_INVALID");
  if (typeof record.sha256 === "string" && !SHA256.test(record.sha256)) throw new Error("OPERATIONAL_HASH_INVALID");
  if (!scanPrivacyCanaries(record).safe) throw new Error("OPERATIONAL_PRIVACY_CANARY");
}

export function assertServerSecretConfiguration(input: Readonly<Record<string, string | undefined>>, runtime: "development" | "production" | "test"): void {
  const forbiddenClientKeys = Object.keys(input).filter((key) => /^(NEXT_PUBLIC_|PUBLIC_)/.test(key) && /(SECRET|SERVICE|PRIVATE|TOKEN|KEY)/i.test(key));
  if (forbiddenClientKeys.length > 0) throw new Error("CLIENT_SECRET_CONFIGURATION_FORBIDDEN");
  if (runtime === "production" && Object.entries(input).some(([key, value]) => /(SECRET|SERVICE|PRIVATE|TOKEN|KEY)/i.test(key) && (!value || value.length < 24))) {
    throw new Error("SERVER_SECRET_CONFIGURATION_INVALID");
  }
}
