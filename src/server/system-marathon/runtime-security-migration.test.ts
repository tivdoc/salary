import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = "202609010005_governance_runtime_security.sql" as const;
const EXPECTED_SHA256 = "3632b1a8d6b8a08360e3f1d99aadb591d42fa577677ce87f77c114e89f41c63e" as const;
const migrationPath = path.resolve(process.cwd(), "supabase", "migrations", MIGRATION);

async function sql(): Promise<string> {
  return (await readFile(migrationPath, "utf8")).replaceAll("\r\n", "\n");
}

describe("V0.10.2 governance runtime security migration", () => {
  it("pins the exact forward-only bytes", async () => {
    const source = await sql();
    expect(createHash("sha256").update(source, "utf8").digest("hex")).toBe(EXPECTED_SHA256);
    expect(source).toContain("'202609010005_governance_runtime_security'");
  });

  it("derives transaction-local tenant, actor and role from a current durable session", async () => {
    const source = await sql();
    const installer = source.slice(
      source.indexOf("create function private.runtime_context_install("),
      source.indexOf("create function private.runtime_verified_tenant()"),
    );
    expect(installer).not.toMatch(/target_(?:tenant|actor|role)\b/u);
    expect(installer).toContain("from public.product_identity_sessions session");
    expect(installer).toContain("session.current_jti = target_jti");
    expect(installer).toContain("session.revoked_at is null");
    expect(installer).toContain("session.expires_at > pg_catalog.statement_timestamp()");
    expect(installer).toContain("pg_catalog.set_config('tivdoc.tenant_id', authoritative.tenant_id, true)");
    expect(installer).toContain("pg_catalog.set_config('tivdoc.actor_id', authoritative.subject, true)");
    expect(installer).toContain("pg_catalog.set_config('tivdoc.runtime_role', effective_role, true)");
  });

  it("replaces all 25 permissive policies with one verified owner policy per table", async () => {
    const source = await sql();
    expect(count(source, /^drop policy governance_[a-z0-9_]+_service_tenant on private\.governance_[a-z0-9_]+;$/gmu)).toBe(25);
    expect(count(source, /^create policy governance_[a-z0-9_]+_verified_tenant on private\.governance_[a-z0-9_]+ to tivdoc_governance_owner using \(tenant_id = private\.runtime_verified_tenant\(\)\) with check \(tenant_id = private\.runtime_verified_tenant\(\)\);$/gmu)).toBe(25);
    expect(count(source, /^alter table private\.governance_[a-z0-9_]+ owner to tivdoc_governance_owner;$/gmu)).toBe(25);
  });

  it("keeps the owner non-login/non-bypass and removes broad governance execution", async () => {
    const source = await sql();
    expect(source).toContain("alter role tivdoc_governance_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;");
    expect(source).toContain("alter role tivdoc_operations_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;");
    expect(source).toContain("alter role tivdoc_worker_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;");
    expect(source).toContain("alter role tivdoc_identity_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;");
    expect(count(source, /^revoke all on function private\.governance_[a-z0-9_]+\(.+\) from service_role;$/gmu)).toBe(21);
    expect(source).not.toMatch(/^grant execute on function private\.governance_.+ to service_role;$/gmu);
    expect(source).not.toMatch(/grant (?:select|insert|update|delete|all) on (?:table )?private\.governance_/iu);
  });

  it("isolates durable session verification behind one non-bypass identity reader", async () => {
    const source = await sql();
    expect(source).toContain("grant usage on schema private to tivdoc_identity_runtime;");
    expect(source).toContain("revoke all on function private.product_identity_session_read(text) from service_role;");
    expect(source).toContain("grant execute on function private.product_identity_session_read(text) to tivdoc_identity_runtime;");
    expect(source).not.toMatch(/grant (?:select|insert|update|delete|all) on (?:table )?(?:public|private)\..+ to tivdoc_identity_runtime/iu);
    expect(source).not.toContain("grant execute on function private.runtime_context_install(text,text,text) to tivdoc_identity_runtime");
  });

  it("binds actor and reviewer role inside the transaction and documents both mutable projections", async () => {
    const source = await sql();
    expect(source).toContain("perform private.runtime_assert_actor(target_actor_id)");
    expect(source).toContain("perform private.runtime_assert_actor(target_claimant_id)");
    expect(source).toContain("perform private.runtime_assert_reviewer_role(target_reviewer_role)");
    expect(source).toContain("Mutable lease projection protected by fencing tokens");
    expect(source).toContain("Mutable single-active-lock projection");
  });
});

function count(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}
