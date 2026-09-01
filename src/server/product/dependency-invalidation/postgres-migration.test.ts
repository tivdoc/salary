import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = resolve(
  process.cwd(),
  "supabase/migrations/202609010007_global_dependency_invalidation.sql",
);

describe("global dependency invalidation PostgreSQL migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("adds currentness plus append-only invalidation history without deleting evidence", () => {
    expect(sql).toContain("create table public.engine_global_dependency_state");
    expect(sql).toContain("create table public.engine_global_dependency_invalidations");
    expect(sql).toContain("engine_global_dependency_history_append_only");
    expect(sql).toContain("engine_global_dependency_state_no_delete");
    expect(sql).not.toMatch(/\bdelete\s+from\b/iu);
    expect(sql).not.toMatch(/\bon\s+delete\s+cascade\b/iu);
  });

  it("represents unpublished supersession honestly and leaves publication distinct", () => {
    expect(sql).toContain("state in ('pending','leased','published','superseded')");
    expect(sql).toContain("superseded_by_invalidation_id");
    expect(sql).toContain("it is never evidence of publication");
  });

  it("forces RLS, excludes web/worker/service ACLs, and grants writes only to operations", () => {
    expect(sql.match(/force row level security/gu)).toHaveLength(2);
    expect(sql).toContain("for all to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime");
    expect(sql).toContain("from public, anon, authenticated, service_role, tivdoc_identity_runtime");
    expect(sql).toContain("grant select, insert, update on public.engine_global_dependency_state\n  to tivdoc_operations_runtime");
    expect(sql).toContain("grant select, insert on public.engine_global_dependency_invalidations\n  to tivdoc_operations_runtime");
    expect(sql).not.toMatch(/grant\s+(?:select|insert|update|delete)[\s\S]*?to\s+(?:tivdoc_web_runtime|tivdoc_worker_runtime|service_role)/iu);
    expect(sql).toContain("perform private.runtime_assert_actor(target_actor_id)");
    expect(sql).toContain("grant execute on function private.global_dependency_actor_assert(text)\n  to tivdoc_operations_runtime");
    expect(sql).toContain("grant usage on sequence public.engine_job_history_sequence_seq\n  to tivdoc_operations_runtime");
  });

  it("starts every case fail-closed and never activates legal dependencies", () => {
    expect(sql).toContain("state.state_sha256, '{}'::text[]");
    expect(sql).toContain("state.lifecycle_state in ('release_hold','cancelled'), false");
    expect(sql).toContain("new.lifecycle_state in ('release_hold','cancelled'), false");
    expect(sql).not.toMatch(/dependencies_approved\s*=\s*true/iu);
  });
});
