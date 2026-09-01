import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES,
  EXPECTED_PORTAL_WEB_READ_POLICY_TABLES,
} from "../../../scripts/canonical-persistence-v091/foundation/inventory.mts";
import { EXPECTED_MIGRATION_SHA256 } from "../../../scripts/canonical-persistence-v091/foundation/migrations.mts";

const MIGRATION = "202609010006_durable_portal_runtime_security.sql" as const;
const FORWARD_REPAIR_MIGRATION = "202609010008_runtime_product_forward_repair.sql" as const;
const migrationPath = path.resolve(process.cwd(), "supabase", "migrations", MIGRATION);
const forwardRepairPath = path.resolve(process.cwd(), "supabase", "migrations", FORWARD_REPAIR_MIGRATION);

async function sql(): Promise<string> {
  return (await readFile(migrationPath, "utf8")).replaceAll("\r\n", "\n");
}

async function forwardRepairSql(): Promise<string> {
  return (await readFile(forwardRepairPath, "utf8")).replaceAll("\r\n", "\n");
}

describe("V0.10.2 durable portal runtime security migration", () => {
  it("pins the exact forward-only migration and canonical metadata", async () => {
    const source = await sql();
    expect(createHash("sha256").update(source, "utf8").digest("hex"))
      .toBe(EXPECTED_MIGRATION_SHA256[MIGRATION]);
    expect(source).toContain("'durable_portal_runtime_security'");
    expect(source).toContain("'tivdoc-durable-portal-runtime-security-v0.10.2'");
    expect(source).toContain("'202609010006_durable_portal_runtime_security'");

    const forwardRepair = await forwardRepairSql();
    expect(createHash("sha256").update(forwardRepair, "utf8").digest("hex"))
      .toBe(EXPECTED_MIGRATION_SHA256[FORWARD_REPAIR_MIGRATION]);
    expect(forwardRepair).toContain("'runtime_product_forward_repair'");
    expect(forwardRepair).toContain("'202609010008_runtime_product_forward_repair'");
  });

  it("derives active ownership only from the verified durable web session", async () => {
    const source = await sql();
    const ownsCase = functionBody(source, "private.runtime_web_owns_case");
    expect(ownsCase).toContain("session_user = 'tivdoc_web_runtime'");
    expect(ownsCase).toContain("target_tenant = private.runtime_verified_tenant()");
    expect(ownsCase).toContain("owner.subject = private.runtime_verified_actor()");
    expect(ownsCase).toContain("owner.status = 'active'");
    expect(ownsCase).toContain("owner.revoked_at is null");
    expect(ownsCase).not.toMatch(/target_(?:actor|subject|role)/u);

    const actor = functionBody(source, "private.runtime_web_verified_actor");
    expect(actor).toContain("when session_user = 'tivdoc_web_runtime' then private.runtime_verified_actor()");
    expect(source).not.toContain("current_setting('tivdoc.actor_id'");
  });

  it("composes exactly fifteen restrictive owner policies over the canonical portal surface", async () => {
    const source = await sql();
    const forwardRepair = await forwardRepairSql();
    const sealed = portalOwnerPolicies(source);
    const repaired = portalOwnerPolicies(forwardRepair);
    expect(sealed).toHaveLength(12);
    expect(repaired).toHaveLength(3);

    const policies = [...sealed, ...repaired];
    expect(policies).toHaveLength(
      EXPECTED_PORTAL_WEB_READ_POLICY_TABLES.length + EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES.length,
    );
    expect(new Set(policies.map(({ table }) => table)).size).toBe(policies.length);
    expect(policies.filter(({ command }) => command === "select").map(({ table }) => table).sort())
      .toEqual([...EXPECTED_PORTAL_WEB_READ_POLICY_TABLES].sort());
    expect(policies.filter(({ command }) => command === "all").map(({ table }) => table).sort())
      .toEqual([...EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES].sort());
    for (const { table } of repaired) {
      expect(forwardRepair).toContain(`create policy tivdoc_portal_web_owned_case on ${table}
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));`);
    }
    expect(source).toContain("and state = 'approved'\n    and revoked_at is null");
  });

  it("uses only column-level portal ACLs and one exact operations finalization grant", async () => {
    const source = await sql();
    expect(matchCount(source, /^grant select \(/gmu)).toBe(12);
    expect(matchCount(source, /^grant insert \(/gmu)).toBe(5);
    expect(matchCount(source, /^grant update \(/gmu)).toBe(4);
    expect(source).toContain("grant usage on sequence public.engine_platform_audit_events_sequence_seq to tivdoc_web_runtime;");
    expect(source).toContain(`grant execute on function private.product_private_report_object_bind(
  text,text,text,bigint,text,text,text,bigint,text,timestamptz
) to tivdoc_operations_runtime;`);
    expect(source).not.toMatch(/^grant .+ to service_role;$/gmu);
    expect(source).not.toMatch(/^grant (?:select|insert|update|delete|truncate|all) on table /gimu);
    expect(source).not.toMatch(/^grant (?:delete|truncate)\b/gimu);
    expect(source).not.toMatch(/\b(?:bypassrls|alter role)\b/iu);
  });

  it("hardens portal and approval functions against forged tenant or cross-case inputs", async () => {
    const source = await sql();
    for (const name of [
      "private.product_owner_lookup",
      "private.product_privacy_append",
      "private.product_private_report_object_bind",
      "private.product_report_object_approve",
      "private.product_report_object_approved_read",
    ] as const) {
      const body = functionBody(source, name);
      expect(body).toContain("private.runtime_verified_tenant()");
      expect(body).not.toContain("current_setting('tivdoc.tenant_id'");
    }
    const lookup = functionBody(source, "private.product_owner_lookup");
    expect(lookup).toContain("target_subject = private.runtime_verified_actor()");
    const privacy = functionBody(source, "private.product_privacy_append");
    expect(privacy).toContain("target_request_kind not in ('export', 'correction', 'deletion')");
    expect(privacy).toContain("private.runtime_web_owns_case(target_tenant, target_case) is not true");
    expect(privacy).toContain("target_tenant is distinct from private.runtime_verified_tenant()");
    expect(privacy).toContain("private.runtime_verified_tenant() is null");
    expect(functionBody(source, "private.product_private_report_object_bind"))
      .toContain("private.runtime_verified_tenant() is null");
    expect(functionBody(source, "private.product_report_object_approve"))
      .toContain("private.runtime_verified_tenant() is null");
    const approvedRead = functionBody(source, "private.product_report_object_approved_read");
    expect(approvedRead).toContain("private.runtime_web_owns_case(target_tenant, target_case)");
    const resolver = functionBody(source, "private.resolve_engine_case_id");
    const webStart = resolver.indexOf("if session_user = 'tivdoc_web_runtime' then");
    const webEnd = resolver.indexOf("end if;", webStart);
    const webResolver = resolver.slice(webStart, webEnd);
    expect(webResolver).not.toContain("insert into public.engine_case_identity");
  });

  it("permits only no-op message conflicts and paired monotonic portal revisions", async () => {
    const source = await sql();
    expect(matchCount(source, /^create (?:constraint )?trigger portal_web_[a-z0-9_]+$/gmu)).toBe(3);
    expect(source).toContain("new.revision <> old.revision + 1");
    expect(source).toContain("new.lifecycle_state is distinct from old.lifecycle_state");
    expect(source).toContain("new is distinct from old");
    expect(source).toContain("create constraint trigger portal_web_case_state_commit");
    expect(source).toContain("deferrable initially deferred");
    expect(source).toContain("message = 'PORTAL_CASE_STATE_LIFECYCLE_REQUIRED'");
  });
});

function portalOwnerPolicies(source: string): readonly Readonly<{ table: string; command: string }>[] {
  return [...source.matchAll(
    /^create policy tivdoc_portal_web_owned_case on public\.([a-z0-9_]+)\n  as restrictive for (select|all) to tivdoc_web_runtime$/gmu,
  )].map((match) => Object.freeze({ table: `public.${match[1]}`, command: match[2] }));
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${name}`);
  const end = source.indexOf("$$;", start);
  if (end < 0) throw new Error(`FUNCTION_END_NOT_FOUND:${name}`);
  return source.slice(start, end + 3);
}

function matchCount(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}
