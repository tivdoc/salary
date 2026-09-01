import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/202609010003_durable_product_integrity_hardening.sql",
);
const priorMigrationPath = join(
  process.cwd(),
  "supabase/migrations/202609010002_durable_product_boundaries.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const priorMigration = readFileSync(priorMigrationPath, "utf8").replaceAll("\r\n", "\n");
const rlsMatrix = readFileSync(
  join(process.cwd(), "scripts/canonical-persistence-v091/matrix/rls.mts"),
  "utf8",
);

function body(name: string): string {
  const marker = `function private.${name}(`;
  const start = migration.indexOf(marker);
  if (start < 0) throw new Error(`missing function: ${name}`);
  const end = migration.indexOf("$$;", start);
  if (end < 0) throw new Error(`unterminated function: ${name}`);
  return migration.slice(start, end);
}

describe("durable product PostgreSQL integrity hardening migration", () => {
  it("is forward-only and preserves the committed durable-boundary migration bytes", () => {
    expect(createHash("sha256").update(priorMigration).digest("hex"))
      .toBe("455e8789de89bef18fb1041e009ab87d7a7e005a294209df3b83456d42ff3e6f");
    expect(migration).toContain("202609010003_durable_product_integrity_hardening");
    expect(migration).not.toMatch(/drop table|truncate table|delete from public\./iu);
  });

  it("binds each object to the canonical report hash and exact canonical PDF hash", () => {
    expect(migration).toMatch(/unique index engine_reports_product_exact_binding_uq[\s\S]*tenant_id, canonical_case_id, report_id, revision, report_sha256, pdf_sha256/iu);
    expect(migration).toMatch(/foreign key \([\s\S]*report_sha256, artifact_sha256[\s\S]*references public\.engine_report_versions\([\s\S]*report_sha256, pdf_sha256/iu);
    const bind = body("product_private_report_object_bind");
    expect(bind).toContain("report.report_sha256 = target_report_sha256");
    expect(bind).toContain("report.pdf_sha256 = target_artifact_sha256");
    expect(bind).toContain("PRODUCT_REPORT_CANONICAL_BINDING_MISMATCH");
  });

  it("seeds the RLS report object with the canonical report PDF hash", () => {
    expect(rlsMatrix).toContain(
      "select tenant_id, canonical_case_id, report_id, revision, report_sha256, pdf_sha256",
    );
    expect(rlsMatrix).toContain(
      "$2, $3, 128, pdf_sha256, 'staged', 0, null, null, now()",
    );
    expect(rlsMatrix).not.toContain("rls-artifact:");
  });

  it("requires the exact latest approved review release on approve, replay, and read", () => {
    for (const name of ["product_report_object_approve", "product_report_object_approved_read"] as const) {
      const sql = body(name);
      expect(sql).toContain("public.engine_review_task_versions approval");
      expect(sql).toContain("approval.report_revision = report.revision");
      expect(sql).toContain("approval.report_sha256 = report.report_sha256");
      expect(sql).toContain("approval.input_sha256 = report.report_sha256");
      expect(sql).toContain("approval.output_sha256 = report.report_sha256");
      expect(sql).toContain("approval.release_state = 'approved'");
      expect(sql).toContain("approval.decision_payload ->> 'decision' = 'approved'");
      expect(sql).toContain("newer.revision > approval.revision");
    }
  });

  it("scopes privacy replay and revision lookup to tenant and compares created-at", () => {
    const privacy = body("product_privacy_append");
    expect(privacy.match(/item\.tenant_id = target_tenant/gu)).toHaveLength(2);
    expect(privacy).toContain("existing.created_at <> target_created_at");
  });

  it("rejects session time rollback, replays only exact rotations, and returns tenant identity", () => {
    const rotate = body("product_session_rotate");
    expect(rotate).toContain("rotated_at >= session.valid_after");
    expect(rotate).toContain("session.valid_after = rotated_at");
    expect(rotate).not.toContain("greatest(session.valid_after, rotated_at)");
    const read = body("product_identity_session_read");
    expect(read).toMatch(/returns table \(\s*tenant_id text/iu);
    expect(read).toContain("select session.tenant_id, session.sid");
  });
});
