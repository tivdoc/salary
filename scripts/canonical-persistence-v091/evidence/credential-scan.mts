const SENSITIVE_KEY = /(?:^|_)(?:password|private_key|client_secret|secret|connection_(?:url|string)|access_token|refresh_token|session_token|provider_token|token|api_key|x_api_key|authorization|cookie|dsn)$/u;

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\b(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//iu,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /(?:^|\n)\s*(?:authorization|cookie|x-api-key)\s*:/iu,
] as const);

export function assertCredentialFreeEvidence(serialized: string): void {
  scanString(serialized);
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("DYNAMIC_EVIDENCE_JSON_INVALID_DURING_CREDENTIAL_SCAN");
  }
  scanDecodedValue(decoded);
}

function scanDecodedValue(value: unknown): void {
  if (typeof value === "string") {
    scanString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanDecodedValue(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/[-.]/gu, "_")
      .toLowerCase();
    if (SENSITIVE_KEY.test(normalized)) throw new Error("DYNAMIC_EVIDENCE_SECRET_FIELD_DETECTED");
    scanDecodedValue(nested);
  }
}

function scanString(value: string): void {
  for (const expression of SECRET_PATTERNS) {
    if (expression.test(value)) throw new Error("DYNAMIC_EVIDENCE_CREDENTIAL_PATTERN_REJECTED");
  }
}
