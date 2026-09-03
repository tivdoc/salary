// Addendum 5 Pool P, Addendum 6 §A6-5 owner-decision mapping. Imports real
// (non-synthetic) draft parameter candidates bound to Pool D fetched
// artifacts, via the exact same private.governance_parameter_import path
// P-0 proved. Every candidate here: state draft, zero attestations,
// activation_allowed stays false at the database level regardless of what
// this script does (only governance_parameter_attestation_append can ever
// flip it, and even that only reaches dual_attested_inactive — never
// active). Nothing here reviews a source, activates a rate, or signs
// anything.
//
// Tenant convention (a call this session made, not specified by any
// addendum — flagged for the owner to confirm or rename): every Pool
// P/S/R/Q unit in this session uses the fixed, non-random tenant
// "legal.reference.il", so the draft catalog is durable and findable
// across runs and across Session B, unlike P-0's own proof script (which
// used a fresh random tenant per run because it was proving the mechanism,
// not building the catalog). A rename later is a plain UPDATE — nothing
// here is attested or activated, so nothing is hard to move.
//
// Binding-hash convention (also this session's call; the addenda specify
// *that* a candidate binds to a fetched hash, not *how* the 8
// DependencyBindings dimensions are computed for a real, non-synthetic
// source — R-8, semantic invalidation, is explicitly deferred to Session
// B, so this is deliberately simple and legible rather than clever):
//   - source_bytes_sha256: hash over the sorted {source_id, source_version,
//     artifact_sha256} of every source this parameter cites — artifact_sha256
//     read from eval/legal-knowledge/manifests/fetch-state.json via the
//     same selectLegalSourceObservation the real pipeline uses, so this
//     chains to fetched bytes, never a URL in a memo.
//   - citations_sha256: hash over the sorted {source_id, source_version,
//     chunk_id, locator} of the exact chunks this parameter's value is
//     read from (real chunk ids from the built corpus, looked up and
//     spot-checked against the source dossier's own numbers below).
//   - interval_sha256: hash of {effective_from, effective_to}.
//   - scope_sha256: hash of {sectors, populations}.
//   - parameter_set_sha256: hash of {parameter_id, parameter_version, value,
//     unit, rounding_policy} — the numeric set this one row itself defines.
//   - rule_spec_sha256 / golden_cases_sha256: deterministic "unassigned"
//     sentinels, exactly as synthetic-fixtures.ts's syntheticBindings does
//     for the same real reason — no RuleSpec or GoldenCaseSet exists until
//     Pool Q runs. Not a placeholder that could be mistaken for a real
//     hash: it hashes an explicit { pool_p_unassigned: true, kind, topic }
//     marker object.
//   - reviewer_decisions_sha256: same sentinel treatment — zero
//     attestations exist at draft-import time by design.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { frozen, legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { dependencyBindingsSchema, parameterCandidateSchema, type DependencyBindings, type ParameterCandidate } from "../../src/engine/legal-operations/contracts.ts";
import type { Wave3Topic } from "../../src/engine/wave3/contracts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { PostgresParameterApprovalRepository } from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const TENANT = "legal.reference.il";
const SYSTEM_ACTOR = "system_import";
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
// runtime_context_install requires a non-null reviewer_org_id for every
// session under the operations role, even one that never touches the
// reviewer-trust stack (202609010005_governance_runtime_security.sql:76).
// There is no foreign key from product_identity_sessions.reviewer_org_id to
// governance_reviewer_organizations, so this is a label, not a real trust
// organization — nothing in Pool P's draft-only import path verifies it.
const REVIEWER_ORG_PLACEHOLDER = "legal.reference.il.no-attestation-placeholder";
const RECEIPT_ROOT = path.join("output", "next", "pool-p");

// --- Pool D artifact lookup (real fetched bytes, real built chunks) -------

const manifest = JSON.parse(readFileSync(
  path.resolve("src/server/engine/legal-knowledge/legal-sources.v0.json"), "utf8",
)) as { sources: Array<{ source_id: string; source_version: string; content_sha256: string | null }> };
const fetchState = JSON.parse(readFileSync(
  path.resolve("eval/legal-knowledge/manifests/fetch-state.json"), "utf8",
)) as { observations: Array<{ source_id: string; source_version: string; artifact_sha256: string; status: string; chunks_path: string | null }> };

function selectObservation(sourceId: string, sourceVersion: string) {
  const source = manifest.sources.find((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
  if (!source) throw new Error(`POOL_P_UNKNOWN_SOURCE:${sourceId}@${sourceVersion}`);
  const matching = [...fetchState.observations].reverse().filter((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
  const observation = source.content_sha256
    ? matching.find((entry) => entry.artifact_sha256 === source.content_sha256 && entry.status === "fetched")
      ?? matching.find((entry) => entry.artifact_sha256 === source.content_sha256)
    : matching.find((entry) => entry.status === "fetched");
  if (!observation) throw new Error(`POOL_P_ARTIFACT_NOT_FETCHED:${sourceId}@${sourceVersion}`);
  return observation;
}

const chunkTextCache = new Map<string, Map<string, string>>();
function chunkText(sourceId: string, sourceVersion: string, chunksPath: string, chunkId: string) {
  const key = `${sourceId}@${sourceVersion}`;
  let byId = chunkTextCache.get(key);
  if (!byId) {
    const doc = JSON.parse(readFileSync(path.resolve(chunksPath), "utf8")) as { chunks: Array<{ chunk_id: string; text: string }> };
    byId = new Map(doc.chunks.map((chunk) => [chunk.chunk_id, chunk.text]));
    chunkTextCache.set(key, byId);
  }
  const text = byId.get(chunkId);
  if (text === undefined) throw new Error(`POOL_P_UNKNOWN_CHUNK:${chunkId}`);
  return text;
}

type SourceRef = Readonly<{ source_id: string; source_version: string }>;
type Citation = Readonly<{ source: SourceRef; chunk_id: string; locator: string; must_contain: readonly string[] }>;

function citation(source: SourceRef, chunkId: string, locator: string, mustContain: readonly string[]): Citation {
  const observation = selectObservation(source.source_id, source.source_version);
  if (!observation.chunks_path) throw new Error(`POOL_P_SOURCE_NOT_BUILT:${source.source_id}@${source.source_version}`);
  const text = chunkText(source.source_id, source.source_version, observation.chunks_path, chunkId);
  for (const needle of mustContain) {
    if (!text.includes(needle)) throw new Error(`POOL_P_CITATION_TEXT_MISMATCH:${chunkId}:${needle}`);
  }
  return frozen({ source, chunk_id: chunkId, locator, must_contain: mustContain });
}

function sentinel(kind: "rule_spec" | "golden_cases" | "reviewer_decisions", topic: Wave3Topic) {
  return legalOperationsSha256({ pool_p_unassigned: true, kind, topic });
}

function buildBindings(input: Readonly<{
  topic: Wave3Topic;
  citations: readonly Citation[];
  effective_from: string;
  effective_to: string | null;
  sectors: readonly string[];
  populations: readonly string[];
  parameter_id: string;
  parameter_version: string;
  value: unknown;
  unit: string;
  rounding_policy: string;
}>): DependencyBindings {
  const sourceRefs = [...new Map(input.citations.map((c) => [`${c.source.source_id}@${c.source.source_version}`, c.source])).values()]
    .sort((a, b) => `${a.source_id}@${a.source_version}`.localeCompare(`${b.source_id}@${b.source_version}`));
  const sourceBytes = sourceRefs.map((ref) => ({ ...ref, artifact_sha256: selectObservation(ref.source_id, ref.source_version).artifact_sha256 }));
  const citations = [...input.citations].sort((a, b) => (`${a.source.source_id}#${a.chunk_id}`).localeCompare(`${b.source.source_id}#${b.chunk_id}`))
    .map((c) => ({ source_id: c.source.source_id, source_version: c.source.source_version, chunk_id: c.chunk_id, locator: c.locator }));
  return dependencyBindingsSchema.parse({
    source_bytes_sha256: legalOperationsSha256({ sources: sourceBytes }),
    citations_sha256: legalOperationsSha256({ citations }),
    interval_sha256: legalOperationsSha256({ effective_from: input.effective_from, effective_to: input.effective_to }),
    scope_sha256: legalOperationsSha256({ sectors: input.sectors, populations: input.populations }),
    parameter_set_sha256: legalOperationsSha256({
      parameter_id: input.parameter_id, parameter_version: input.parameter_version,
      value: input.value, unit: input.unit, rounding_policy: input.rounding_policy,
    }),
    rule_spec_sha256: sentinel("rule_spec", input.topic),
    golden_cases_sha256: sentinel("golden_cases", input.topic),
    reviewer_decisions_sha256: sentinel("reviewer_decisions", input.topic),
  });
}

export type DraftParameterInput = Readonly<{
  parameter_id: string;
  parameter_version: string;
  topic: Wave3Topic;
  value: ParameterCandidate["value"];
  unit: string;
  rounding_policy: ParameterCandidate["rounding_policy"];
  effective_from: string;
  effective_to: string | null;
  sectors: readonly string[];
  populations: readonly string[];
  support_roles: readonly ParameterCandidate["support_roles"][number][];
  citations: readonly Citation[];
  decision_id?: string | null;
  branch?: string | null;
}>;

export function buildCandidate(input: DraftParameterInput): ParameterCandidate {
  const operativeSourceVersionIds = [...new Set(input.citations.map((c) => `${c.source.source_id}@${c.source.source_version}`))];
  const bindings = buildBindings({
    topic: input.topic, citations: input.citations, effective_from: input.effective_from, effective_to: input.effective_to,
    sectors: input.sectors, populations: input.populations, parameter_id: input.parameter_id,
    parameter_version: input.parameter_version, value: input.value, unit: input.unit, rounding_policy: input.rounding_policy,
  });
  const seed = frozen({
    schema_version: "tivdoc-parameter-candidate-v0.6.0" as const,
    parameter_id: input.parameter_id,
    parameter_version: input.parameter_version,
    topic: input.topic,
    value: input.value,
    unit: input.unit,
    rounding_policy: input.rounding_policy,
    effective_from: input.effective_from,
    effective_to: input.effective_to,
    sectors: input.sectors,
    populations: input.populations,
    operative_source_version_ids: operativeSourceVersionIds,
    support_roles: input.support_roles,
    bindings,
    decision_id: input.decision_id ?? null,
    branch: input.branch ?? null,
  });
  return parameterCandidateSchema.parse({ ...seed, candidate_sha256: legalOperationsSha256(seed) });
}

export { citation, TENANT, SYSTEM_ACTOR };

export type OpenDecisionInput = Readonly<{ decision_id: string; topic: Wave3Topic; question: string; dossier_anchor: string }>;

// --- DEV import runner -----------------------------------------------------

export async function importPoolPBatch(
  batchName: string,
  candidates: readonly ParameterCandidate[],
  openDecisions: readonly OpenDecisionInput[] = [],
): Promise<void> {
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("POOL_P_ENV_MISSING");
  const { default: pg } = await import("pg");
  const { createHash } = await import("node:crypto");
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const now = Math.floor(Date.now() / 1_000);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$8,$7,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
         expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
      [TENANT, SYSTEM_SESSION.sid, SYSTEM_ACTOR, SYSTEM_SESSION.jti, now - 5, now + 3_600 * 24 * 365,
        sha256(`${TENANT}|${SYSTEM_SESSION.sid}|${SYSTEM_ACTOR}|${SYSTEM_SESSION.jti}`), REVIEWER_ORG_PLACEHOLDER],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_pool_p_import",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });

  const decisionResults: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const decision of openDecisions) {
      const client = await factory.acquire();
      try {
        await client.query(statement("pool_p_decision_begin", "begin", []));
        await client.query(statement("pool_p_decision_context", "select * from private.runtime_context_install($1,$2,$3)",
          [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `poolp:decision:${sha256(decision.decision_id).slice(0, 8)}`]));
        const idempotencyKey = `pool-p.decision.${decision.decision_id}`.replace(/[^A-Za-z0-9._:@-]/gu, "_").slice(0, 200);
        await client.query(statement("pool_p_decision_register",
          "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
          [TENANT, JSON.stringify(decision), idempotencyKey, sha256(`decision:${decision.decision_id}`), new Date().toISOString()]));
        await client.query(statement("pool_p_decision_commit", "commit", []));
        decisionResults.push({ decision_id: decision.decision_id, state: "registered_or_already_open" });
      } catch (error) {
        await client.query(statement("pool_p_decision_rollback", "rollback", [])).catch(() => undefined);
        // Idempotent replay of an already-open decision raises nothing (the
        // idempotency ledger returns the prior receipt); a genuinely
        // duplicate *first* registration would instead hit legal_open_decisions'
        // primary key. Both are "already open, fine to proceed" here — only
        // report a real failure.
        const message = String((error as Error).message ?? "");
        if (!message.includes("duplicate key value") && !message.includes("legal_open_decisions_pkey")) {
          decisionResults.push({ decision_id: decision.decision_id, error: message.slice(0, 300) });
        } else {
          decisionResults.push({ decision_id: decision.decision_id, state: "already_registered" });
        }
      } finally {
        client.release();
      }
    }
    for (const candidate of candidates) {
      const client = await factory.acquire();
      try {
        await client.query(statement("pool_p_begin", "begin", []));
        await client.query(statement("pool_p_context", "select * from private.runtime_context_install($1,$2,$3)",
          [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `poolp:${sha256(candidate.parameter_id + candidate.parameter_version).slice(0, 8)}`]));
        const context: PostgresTransactionContext = { client, transaction_id: `poolp:${sha256(candidate.parameter_id + candidate.parameter_version).slice(0, 12)}` };
        const repo = new PostgresParameterApprovalRepository(context, TENANT);
        const idempotencyKey = `pool-p.import.${candidate.parameter_id}.${candidate.parameter_version}`.replace(/[^A-Za-z0-9._:@-]/gu, "_").slice(0, 200);
        const receipt = await repo.importCandidate(candidate, { idempotency_key: idempotencyKey, occurred_at: new Date().toISOString() });
        const snapshot = await repo.readCurrent("parameter_approval", candidate.parameter_id, candidate.parameter_version);
        await client.query(statement("pool_p_commit", "commit", []));
        results.push({
          parameter_id: candidate.parameter_id, parameter_version: candidate.parameter_version,
          candidate_sha256: candidate.candidate_sha256, state: snapshot.receipt.state,
          revision: snapshot.receipt.revision, idempotent_replay: receipt.idempotent_replay,
        });
      } catch (error) {
        await client.query(statement("pool_p_rollback", "rollback", [])).catch(() => undefined);
        results.push({ parameter_id: candidate.parameter_id, parameter_version: candidate.parameter_version, error: String((error as Error).message).slice(0, 300) });
      } finally {
        client.release();
      }
    }
  } finally {
    await factory.close();
  }

  await mkdir(RECEIPT_ROOT, { recursive: true });
  const receiptPath = path.join(RECEIPT_ROOT, `${batchName}.json`);
  await writeFile(receiptPath, `${JSON.stringify({ tenant: TENANT, batch: batchName, decisions: decisionResults, results }, null, 2)}\n`);
  const failed = [...decisionResults.filter((r) => "error" in r), ...results.filter((r) => "error" in r)];
  process.stdout.write(`${JSON.stringify({ batch: batchName, total: results.length, failed: failed.length, receipt: receiptPath })}\n`);
  if (failed.length > 0) {
    process.stderr.write(`${JSON.stringify(failed, null, 2)}\n`);
    process.exitCode = 1;
  }
}
