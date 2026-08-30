import { immutable } from "./canonical.ts";

export type SafeCaseLogEntry = Readonly<{
  event_code: string;
  case_id: string;
  revision: number;
  state: string;
  command_sha256: string;
  audit_event_sha256: string;
}>;

const SAFE_KEYS = new Set(["event_code", "case_id", "revision", "state", "command_sha256", "audit_event_sha256"]);
const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function assertOpaqueIdentifier(value: string): void {
  if (!OPAQUE_ID.test(value)) throw new TypeError("privacy_identifier_not_opaque");
}

export function assertPrivacySafeLogEntry(entry: SafeCaseLogEntry): void {
  if (Object.keys(entry).some((key) => !SAFE_KEYS.has(key))) throw new TypeError("privacy_log_unknown_field");
  assertOpaqueIdentifier(entry.event_code);
  assertOpaqueIdentifier(entry.case_id);
  assertOpaqueIdentifier(entry.state);
  if (!Number.isInteger(entry.revision) || entry.revision < 0) throw new TypeError("privacy_log_revision_invalid");
  if (!SHA256.test(entry.command_sha256) || !SHA256.test(entry.audit_event_sha256)) {
    throw new TypeError("privacy_log_hash_invalid");
  }
}

export class PrivacySafeCaseLogger {
  readonly #entries: SafeCaseLogEntry[] = [];

  write(entry: SafeCaseLogEntry): void {
    assertPrivacySafeLogEntry(entry);
    this.#entries.push(immutable({ ...entry }));
  }

  entries(): readonly SafeCaseLogEntry[] {
    return immutable(this.#entries.map((entry) => ({ ...entry })));
  }
}
