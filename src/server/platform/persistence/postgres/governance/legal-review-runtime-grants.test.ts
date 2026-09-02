import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_MIGRATION_CHAIN,
  EXPECTED_MIGRATION_SHA256,
} from "../../../../../../scripts/canonical-persistence-v091/foundation/migrations.mts";

// V0.10.13 W2. Migration 011 created the three legal review entry points as
// SECURITY DEFINER functions owned by the governance owner and granted execute
// to that role only. The runtime principals that actually call them were never
// granted anything, so every operations request reached the database and was
// refused by the ACL check with SQLSTATE 42501 — a 422 with no SQLSTATE by the
// time it crossed the boundary.
//
// These cases pin the repair, and pin the shape of the model it belongs to: the
// functions stay owned by the governance owner, the reserved Supabase roles
// stay revoked, and each principal holds only the signatures it invokes.

const REPAIR = "202609020001_legal_review_runtime_execute_grants.sql";

const ENTRY_POINTS = Object.freeze([
  Object.freeze({
    name: "governance_legal_review_queue_list",
    principals: Object.freeze(["tivdoc_operations_runtime"]),
  }),
  Object.freeze({
    name: "governance_legal_review_action_append",
    principals: Object.freeze(["tivdoc_operations_runtime"]),
  }),
  Object.freeze({
    name: "governance_legal_review_packet_enqueue",
    principals: Object.freeze(["tivdoc_operations_runtime", "tivdoc_worker_runtime"]),
  }),
]);

function migrationText(name: string): string {
  return readFileSync(path.resolve("supabase", "migrations", name), "utf8");
}

const chainText = EXPECTED_MIGRATION_CHAIN.map((name) => migrationText(name)).join("\n");

describe("V0.10.13 legal review runtime execute grants", () => {
  it("keeps the repair in the pinned chain, immediately after 011 and digest-pinned", () => {
    expect(EXPECTED_MIGRATION_CHAIN).toContain(REPAIR);
    expect(EXPECTED_MIGRATION_CHAIN.indexOf(REPAIR as never))
      .toBe(EXPECTED_MIGRATION_CHAIN.indexOf("202609010011_durable_legal_review.sql") + 1);
    expect(EXPECTED_MIGRATION_SHA256[REPAIR as never]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("grants each entry point to exactly the principals that invoke it", () => {
    const repair = migrationText(REPAIR);
    for (const entry of ENTRY_POINTS) {
      const grant = new RegExp(
        `grant execute on function private\\.${entry.name}\\([^)]*\\)\\s*to ([^;]+);`, "u",
      ).exec(repair);
      expect(grant, entry.name).not.toBeNull();
      const granted = (grant?.[1] ?? "").split(",").map((part) => part.trim()).sort();
      expect(granted, entry.name).toEqual([...entry.principals].sort());
    }
  });

  it("never grants an entry point to a reserved or public role", () => {
    const repair = migrationText(REPAIR);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(new RegExp(`grant execute on function private\\.governance_legal_review[^;]*to[^;]*\\b${role}\\b`, "u")
        .test(repair), role).toBe(false);
    }
    for (const entry of ENTRY_POINTS) {
      expect(repair, entry.name).toContain(`revoke all on function private.${entry.name}(`);
    }
  });

  it("leaves every entry point owned by the governance owner", () => {
    for (const entry of ENTRY_POINTS) {
      expect(chainText).toContain(`alter function private.${entry.name}(`);
      expect(chainText).toContain("owner to tivdoc_governance_owner");
    }
  });

  it("grants every legal review entry point some runtime principal", () => {
    // The defect was an entire family reachable only by its owning role. A new
    // entry point added without a runtime grant fails here rather than at a 422.
    for (const entry of ENTRY_POINTS) {
      const granted = new RegExp(
        `grant execute on function private\\.${entry.name}\\([^)]*\\)\\s*to [^;]*tivdoc_(operations|worker)_runtime`, "u",
      ).test(chainText);
      expect(granted, entry.name).toBe(true);
    }
  });
});
