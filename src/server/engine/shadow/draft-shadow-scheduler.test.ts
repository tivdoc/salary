// L7-6 / D1. The scheduler runs the corpus through the seven drafts inside a
// fenced lease under a v0.11 envelope in the draft mode; every execution is
// traced; the kill switch and the flags stay off by default; a v0.10
// envelope still validates and the new mode cannot be claimed without its pin.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { runDraftShadow } from "../../../engine/shadow/draft-shadow-run.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256 } from "../../../engine/shadow/synthetic-corpus.ts";
import { testBindings } from "../../../engine/shadow/test-support.ts";
import { DURABLE_SHADOW_ENVELOPE_V011, durableShadowRunEnvelopeSchema } from "./durable-contracts.ts";
import { DurableOfflineShadowScheduler } from "./durable-scheduler.ts";
import { LocalFileDurableShadowStateStore, verifySchedulerAuditChain } from "./durable-store.ts";
import { buildDraftShadowEnvelope, buildDurableSyntheticShadowEnvelope } from "./durable-synthetic-fixtures.ts";
import { readOfflineShadowFlags, type OfflineShadowFlags } from "./flags.ts";

const LIMITS = { max_jobs: 4, max_queued: 4, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 8_192, max_lease_ms: 60_000 };
const ENABLED = { enabled: true, synthetic_enabled: true, public_enabled: false } as const;

/** Test bindings: every parameter a draft, graded text_verified, from the test values (population-aware since L8-4). */
const bindings = testBindings;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-draft-shadow-"));
  roots.push(root);
  const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
  return { store, scheduler: (flags: OfflineShadowFlags = ENABLED) => new DurableOfflineShadowScheduler({ store, flags, limits: LIMITS, now: () => "2026-09-05T00:00:00.000Z" }) };
}

const command = (suffix: string) => ({ idempotency_key: `idempotency_${suffix}`, correlation_id: `correlation_${suffix}` } as const);

describe("the draft shadow run", () => {
  it("computes every case of the corpus through every spec it names, deterministically", () => {
    const first = runDraftShadow({ run_id: "shadow.run.test", bindings });
    const second = runDraftShadow({ run_id: "shadow.run.test", bindings });
    expect(first.result_sha256).toBe(second.result_sha256);
    expect(first.execution_mode).toBe("draft_parameters_synthetic_inputs");
    expect(first.corpus_sha256).toBe(SYNTHETIC_CORPUS_SHA256);
    expect(first.counts).toMatchObject({ cases: SYNTHETIC_CORPUS.length, executions: 114, ran: 80, preparation_refused: 30, executor_refused: 4, active_real_parameter_count: 0, monetary_output_count: 0, finding_count: 0, customer_report_count: 0 });
    expect(first.counts.deltas_computed + first.counts.deltas_not_applicable + first.counts.deltas_paid_refused).toBe(first.counts.ran);
    expect(first.counts.deltas_paid_refused).toBe(0);
    for (const execution of first.executions) {
      expect(execution.parameter_states.every((state) => state === "draft")).toBe(true);
      if (execution.status === "ran") {
        expect(execution.trace_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(execution.provenance?.execution_grade).toBeDefined();
        expect(execution.delta?.is_finding).toBe(false);
      } else {
        expect(execution.output).toBeNull();
        expect(execution.delta).toBeNull();
      }
    }
    expect(Object.keys(first.refusals_by_reason).sort()).toEqual([
      "executor:RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE",
      "preparation:fact.below_confidence_threshold", "preparation:fact.conflicted", "preparation:fact.missing",
      "preparation:fact.stale", "preparation:fact.unconfirmed", "preparation:rate_not_published", "preparation:transformation.failed",
    ]);
  });

  it("runs every branch of every open decision when asked", () => {
    const all = runDraftShadow({ run_id: "shadow.run.branches", bindings, branch_policy: "all" });
    const decided = all.executions.filter((execution) => execution.decision_id !== null);
    const byDecision = new Map<string, Set<string>>();
    for (const execution of decided) {
      if (!byDecision.has(execution.decision_id!)) byDecision.set(execution.decision_id!, new Set());
      byDecision.get(execution.decision_id!)!.add(execution.branch ?? "single");
    }
    expect([...byDecision.entries()].map(([id, branches]) => [id.replace(/^legal\.reference\.il\.decision\./u, ""), [...branches].sort()])).toEqual([
      ["min_wage_hourly_divisor", ["182", "186"]],
      ["working_time_daily_threshold", ["administrative", "statute"]],
      ["rest_day_overtime_composition", ["additive"]],
      ["pension_wage_cap_section", ["section1", "section2"]],
      ["pension_2011_2016_precedence", ["order_2011_2014_row", "order_2016_2017_rates"]],
      ["convalescence_2026_rate_period", ["calendar_year_2026", "from_signature_2026_07", "havraa_year"]],
    ]);
    expect(all.counts.executions).toBeGreaterThan(95);
  });
});

describe("the v0.11 envelope", () => {
  it("names the draft mode with its pin; a v0.10 envelope still validates", () => {
    const draft = buildDraftShadowEnvelope({ run_id: "shadow.run.draft.001", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 25, synthetic_inputs: SYNTHETIC_CORPUS.length });
    expect(draft.schema_version).toBe(DURABLE_SHADOW_ENVELOPE_V011);
    expect(draft.execution_mode).toBe("draft_parameters_synthetic_inputs");
    expect(draft.draft_input_pin).toMatchObject({ active_real_parameter_count: 0, draft_parameter_versions: 25, synthetic_inputs: SYNTHETIC_CORPUS.length, extraction_used: false, corpus_sha256: SYNTHETIC_CORPUS_SHA256, tenant_id: "legal.synthetic.proof" });
    expect(durableShadowRunEnvelopeSchema.safeParse(draft).success).toBe(true);
    const legacy = buildDurableSyntheticShadowEnvelope();
    expect(legacy.schema_version).toBe("tivdoc-durable-offline-shadow-envelope-v0.10.0");
    expect(durableShadowRunEnvelopeSchema.safeParse(legacy).success).toBe(true);
  });

  it("refuses the draft mode without its pin, the pin without the mode, a real parameter, or extraction", () => {
    const draft = buildDraftShadowEnvelope({ run_id: "shadow.run.draft.002", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 1, synthetic_inputs: 1 });
    const legacy = buildDurableSyntheticShadowEnvelope();
    const reseal = (content: Record<string, unknown>) => {
      const rest = Object.fromEntries(Object.entries(content).filter(([key, value]) => key !== "envelope_sha256" && value !== undefined));
      return { ...rest, envelope_sha256: canonicalSha256(rest) };
    };
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...draft, draft_input_pin: undefined })).success).toBe(false);
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...legacy, draft_input_pin: draft.draft_input_pin })).success).toBe(false);
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...draft, schema_version: "tivdoc-durable-offline-shadow-envelope-v0.10.0" })).success).toBe(false);
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...draft, draft_input_pin: { ...draft.draft_input_pin, active_real_parameter_count: 1 } })).success).toBe(false);
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...draft, draft_input_pin: { ...draft.draft_input_pin, extraction_used: true } })).success).toBe(false);
    expect(durableShadowRunEnvelopeSchema.safeParse(reseal({ ...draft, draft_input_pin: { ...draft.draft_input_pin, tenant_id: "legal.reference.il" } })).success).toBe(false);
  });
});

describe("the scheduler runs the drafts", () => {
  it("schedules, leases, executes the corpus and completes with zero prohibited outputs; the audit chain verifies across a restart", async () => {
    const { scheduler, store } = await fixture();
    const envelope = buildDraftShadowEnvelope({ run_id: "shadow.run.draft.corpus", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 25, synthetic_inputs: SYNTHETIC_CORPUS.length });
    const first = scheduler();
    const scheduled = await first.schedule(envelope, command("draft_schedule"));
    await first.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, ...command("draft_enqueue") });
    const [lease] = await first.lease({ worker_id: "worker_draft_001", now: "2026-09-05T00:00:00.000Z", lease_ms: 60_000, limit: 1, correlation_id: "correlation_draft_lease" });
    const restarted = scheduler();
    let result: ReturnType<typeof runDraftShadow> | null = null;
    const completed = await restarted.executeLease(lease, "correlation_draft_execute", async (running) => {
      expect(running.execution_mode).toBe("draft_parameters_synthetic_inputs");
      result = runDraftShadow({ run_id: running.run_id, bindings });
      return {
        result_sha256: result.result_sha256,
        comparison_sha256: canonicalSha256({ deltas: result.executions.map((execution) => execution.delta) }),
        disagreement_id: null,
        monetary_output_count: 0 as const,
        finding_count: 0 as const,
        customer_report_count: 0 as const,
        automatic_customer_promotion: false as const,
        automatic_production_promotion: false as const,
      };
    });
    expect(completed.state).toBe("completed");
    expect(completed.result_sha256).toBe(result!.result_sha256);
    expect(completed.envelope.execution_mode).toBe("draft_parameters_synthetic_inputs");
    expect(completed.automatic_customer_promotion).toBe(false);
    const audit = verifySchedulerAuditChain((await store.read()).audit);
    expect(audit.valid).toBe(true);
    expect(audit.event_count).toBe(5);
  });

  it("the flags and the kill switch are off by default; nothing schedules without them", async () => {
    const { scheduler } = await fixture();
    const flags = readOfflineShadowFlags({}, "test");
    expect(flags).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
    const disabled = scheduler(flags);
    const envelope = buildDraftShadowEnvelope({ run_id: "shadow.run.draft.off", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 1, synthetic_inputs: 1 });
    await expect(disabled.schedule(envelope, command("draft_off"))).rejects.toThrow(/SHADOW_.*DISABLED/u);
    const enabled = scheduler();
    expect((await enabled.snapshot()).kill_switch.engaged).toBe(false);
    await enabled.engageKillSwitch({ ...command("draft_kill"), reason_code: "SYNTHETIC_EMERGENCY_STOP" });
    await expect(enabled.schedule(envelope, command("draft_killed"))).rejects.toThrow("SHADOW_KILL_SWITCH_ENGAGED");
  });

  it("refuses to complete a run that claims a monetary output, a finding or a report", async () => {
    const { scheduler } = await fixture();
    const control = scheduler();
    const envelope = buildDraftShadowEnvelope({ run_id: "shadow.run.draft.guard", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 1, synthetic_inputs: 1 });
    const scheduled = await control.schedule(envelope, command("guard_schedule"));
    await control.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, ...command("guard_enqueue") });
    const [lease] = await control.lease({ worker_id: "worker_guard", now: "2026-09-05T00:00:00.000Z", lease_ms: 60_000, limit: 1, correlation_id: "correlation_guard_lease" });
    await control.start(lease, "correlation_guard_start");
    await expect(control.complete(lease, {
      correlation_id: "correlation_guard_complete", result_sha256: "a".repeat(64), comparison_sha256: "b".repeat(64), disagreement_id: null,
      monetary_output_count: 1 as never, finding_count: 0, customer_report_count: 0, automatic_customer_promotion: false, automatic_production_promotion: false,
    })).rejects.toThrow("SHADOW_PROHIBITED_OUTPUT_OR_PROMOTION");
  });
});
