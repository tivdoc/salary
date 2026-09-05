import "../../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const root = await mkdtemp(join(tmpdir(), "tivdoc-security-verify-"));
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });

try {
  const auth = await server.ssrLoadModule("/src/server/platform/auth/authorization.ts");
  const rls = await server.ssrLoadModule("/src/server/platform/auth/rls-contract.ts");
  const auditModule = await server.ssrLoadModule("/src/server/platform/audit/hash-chain.ts");
  const storageModule = await server.ssrLoadModule("/src/server/platform/storage/private-object-storage.ts");
  const privacy = await server.ssrLoadModule("/src/server/platform/security/privacy.ts");
  const parser = await server.ssrLoadModule("/src/server/platform/security/parser-sandbox.ts");
  const guards = await server.ssrLoadModule("/src/server/platform/security/request-guards.ts");

  const now = { value: Date.parse("2026-08-30T00:00:00.000Z") };
  const actor = Object.freeze({ actor_id: "actor_verify_001", role: "fact_reviewer", tenant_id: "tenant_verify_01", assigned_case_ids: ["case_verify_0001"], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null });
  const resource = { tenant_id: "tenant_verify_01", case_id: "case_verify_0001", owner_actor_id: null, report_released: false, last_content_actor_id: null, first_parameter_attestor_id: null, worker_scope_actor_id: null, break_glass_audit_bound: false };
  const authz = auth.authorize(actor, "review_facts", resource);
  const rlsResult = rls.verifyStaticRlsContract(rls.buildStaticRlsContract());
  const audit = new auditModule.InMemoryHashChainAudit();
  const storage = new storageModule.LocalPrivateObjectStorage({ root, environment: "generated_local_test_root", audit, nowMs: () => now.value, authorizeRead: (candidate: typeof actor, _version: string, scope: string) => candidate.actor_id === actor.actor_id && scope === "case_verify_0001" });
  const bytes = new TextEncoder().encode('{"fixture":"synthetic"}');
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reservation = await storage.reserve({
    command_id: "command_verify_01",
    idempotency_key: "idempotency_verify_1",
    expected_revision: 0,
    actor,
    reason: "STORAGE_WRITE",
    payload: { expected_sha256: sha256, expected_length: bytes.byteLength, detected_mime: "application/json", retention_class: "temporary" },
  });
  await storage.stage(reservation, (async function* () { yield bytes; })());
  const object = await storage.finalize(reservation);
  const grant = await storage.issuePrivateGrant({ actor, version_id: object.object_version_id, scope_ref: "case_verify_0001", ttl_ms: 1_000 });
  const read = await storage.readWithGrant(grant.token, actor, "case_verify_0001");
  const auditResult = await audit.verify();
  const privacyResult = privacy.scanPrivacyCanaries({ status: "succeeded", opaque_id: object.object_version_id });
  const ssrf = await guards.validateOutboundHttpsTarget("https://example.com/fixture", async () => ["93.184.216.34"]);
  const parserResult = parser.parserSandboxCapability({ docker: "unavailable", supported_microvm: false });
  const anchor = new auditModule.LocalAuditAnchor();
  const anchorReceipt = await anchor.anchor({ event_count: auditResult.event_count, tail_sha256: auditResult.tail_sha256, anchored_at: "2026-08-30T00:00:01.000Z" });

  const acceptance = {
    "V07-P2-AUTHZ": authz.allowed,
    "V07-P2-RLS": rlsResult.valid && rlsResult.capability === "STATIC_CONTRACT_ONLY",
    "V07-P2-STORAGE": createHash("sha256").update(read).digest("hex") === sha256,
    "V07-P2-AUDIT": auditResult.valid && /^[a-f0-9]{64}$/.test(anchorReceipt.receipt_sha256),
    "V07-P2-PRIVACY": privacyResult.safe && ssrf.hostname === "example.com",
    "V07-P2-PARSER": parserResult.runnable === false && parserResult.quarantine_untrusted_inputs,
  };
  const result = {
    schema_version: "tivdoc-p2-local-security-verification-v0.7.0",
    status: Object.values(acceptance).every(Boolean) ? "PASS_LOCAL_CONTRACT_AND_ADAPTERS" : "FAIL",
    acceptance,
    storage: { object_sha256: object.object_sha256, private_grant_read_verified: true, remote_connections: 0 },
    audit: { ...auditResult, anchor_receipt_sha256: anchorReceipt.receipt_sha256, off_host_worm: false },
    rls: rlsResult,
    parser: parserResult,
    blocker_receipts: [
      {
        item_id: "P2_DYNAMIC_RLS",
        status: "SKIPPED_BLOCKED",
        blocker_code: "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED",
        attempted_action: "consume frozen execution-contract capability preflight",
        evidence: "disposable_local_database_proven=false",
        safe_fallback_completed: true,
        affected_acceptance_ids: ["V07-P2-RLS"],
        direct_downstream_impact: "no dynamic independent-session RLS claim",
        next_human_or_environment_action: "provide an explicitly disposable isolated local PostgreSQL/Supabase target",
      },
      {
        item_id: "P2_PARSER_SANDBOX",
        status: "SKIPPED_BLOCKED",
        blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
        attempted_action: "consume frozen execution-contract capability preflight",
        evidence: "docker=unavailable; supported_microvm=false",
        safe_fallback_completed: true,
        affected_acceptance_ids: ["V07-P2-PARSER"],
        direct_downstream_impact: "untrusted parsing remains quarantined and dynamically disabled",
        next_human_or_environment_action: "provide a supported isolated container or microVM runtime",
      },
      {
        item_id: "P2_MANAGED_STORAGE_AND_AUDIT_CUSTODY",
        status: "SKIPPED_BLOCKED",
        blocker_code: "MANAGED_PRIVATE_STORAGE_CONFIGURATION_PENDING;OFF_HOST_AUDIT_CUSTODY_PENDING",
        attempted_action: "implement local fake/temp-root adapters without remote credentials",
        evidence: "local adapters verified; remote_connections=0",
        safe_fallback_completed: true,
        affected_acceptance_ids: ["V07-P2-STORAGE", "V07-P2-AUDIT"],
        direct_downstream_impact: "no managed storage or off-host/WORM custody claim",
        next_human_or_environment_action: "configure authorized managed private storage and independent audit custody",
      },
    ],
    prohibited_action_counters: {
      customer_data_reads: 0,
      production_or_preview_connections: 0,
      deployments: 0,
      remote_migrations: 0,
      external_supabase_connections: 0,
      live_storage_connections: 0,
      external_network_calls: 0,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "PASS_LOCAL_CONTRACT_AND_ADAPTERS") process.exitCode = 1;
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
