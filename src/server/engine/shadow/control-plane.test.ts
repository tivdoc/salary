import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineShadowControlPlane } from "./control-plane.ts";
import { createShadowDefinition } from "./contracts.ts";
import { disabledOfflineShadowFlags, readOfflineShadowFlags } from "./flags.ts";
import { buildSyntheticShadowDefinition, SyntheticMechanicsShadowEvaluator } from "./synthetic-fixtures.ts";

const ENABLED = Object.freeze({ enabled: true, synthetic_enabled: true, public_enabled: false });
const NOW = () => "2042-01-01T00:00:00.000Z";

function plane(mode: "synthetic_test" | "real_inactive" = "synthetic_test", evaluator = new SyntheticMechanicsShadowEvaluator()) {
  const control = new OfflineShadowControlPlane({ flags: ENABLED, evaluator, now: NOW });
  const definition = control.registerDefinition(buildSyntheticShadowDefinition(mode));
  return { control, definition, evaluator };
}

function unsignedDefinition(definition: ReturnType<typeof buildSyntheticShadowDefinition>) {
  const { definition_sha256, ...content } = definition;
  void definition_sha256;
  return content;
}

describe("V07-P4-SHADOW flags and classification boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults off and hard-fails every enabled offline fixture mode in production", () => {
    expect(disabledOfflineShadowFlags()).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
    expect(readOfflineShadowFlags({}, "test")).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
    expect(() => readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "true" }, "production")).toThrow("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
  });

  it("rejects unknown, customer and Production-shaped bundle classifications", () => {
    const base = buildSyntheticShadowDefinition();
    const unsigned = { ...unsignedDefinition(base), bundles: [{ ...base.bundles[0], classification: "customer" }] };
    expect(() => createShadowDefinition(unsigned as never)).toThrow();
    expect(() => createShadowDefinition({ ...unsigned, bundles: [{ ...base.bundles[0], classification: "production" }] } as never)).toThrow();
    expect(() => createShadowDefinition({ ...unsigned, bundles: [{ ...base.bundles[0], classification: "unknown" }] } as never)).toThrow();
    expect(() => createShadowDefinition({ ...unsignedDefinition(base), bundles: [{ ...base.bundles[0], classification: "approved_public_non_identifying", public_approval_sha256: null }] })).toThrow("shadow_public_bundle_requires_approval");
  });

  it("refuses all operations while disabled", () => {
    const control = new OfflineShadowControlPlane({ flags: disabledOfflineShadowFlags(), evaluator: new SyntheticMechanicsShadowEvaluator(), now: NOW });
    expect(() => control.registerDefinition(buildSyntheticShadowDefinition())).toThrow("SHADOW_OFFLINE_DISABLED");
  });
});

describe("V07-P4-SHADOW deterministic control plane", () => {
  it("runs seven synthetic slots, compares pinned versions and replays exactly", async () => {
    const { control, definition, evaluator } = plane();
    const scheduled = control.schedule({ definition_id: definition.definition_id, run_id: "shadow.run.synthetic.001", idempotency_key: "shadow-schedule-0001" });
    const replayedSchedule = control.schedule({ definition_id: definition.definition_id, run_id: "shadow.run.synthetic.001", idempotency_key: "shadow-schedule-0001" });
    expect(replayedSchedule).toEqual(scheduled);
    const completed = await control.execute(scheduled.run_id);
    expect(completed.state).toBe("completed");
    expect(completed.slots).toHaveLength(7);
    expect(completed.metrics).toMatchObject({ slot_count: 7, monetary_output_count: 0, finding_count: 0, customer_report_count: 0 });
    expect(completed.stage_statuses).toMatchObject({ evaluation: "complete", comparison: "complete", reviewer_handoff: "pending_human_review" });
    expect(completed.reviewer_handoff).toMatchObject({ status: "pending_human_review", human_review_required: true, promotion_allowed: false });
    expect(completed.reviewer_handoff.packet_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.slots.every((slot) => slot.baseline.status === "synthetic_mechanics_complete" && slot.candidate.status === "synthetic_mechanics_complete")).toBe(true);
    expect(completed.promotion_thresholds).toBeNull();
    expect(completed.promotion_eligible).toBe(false);
    expect(control.replay(completed.run_id)).toEqual(completed);
    expect(evaluator.calls).toBe(14);
  });

  it("schedules batches deterministically and idempotently", () => {
    const first = plane();
    const input = {
      batch_id: "shadow.batch.synthetic.001",
      idempotency_key: "shadow-batch-synthetic-0001",
      runs: [
        { definition_id: first.definition.definition_id, run_id: "shadow.run.batch.002" },
        { definition_id: first.definition.definition_id, run_id: "shadow.run.batch.001" },
      ],
    } as const;
    const scheduled = first.control.scheduleBatch(input);
    const replay = first.control.scheduleBatch(input);
    expect(scheduled.map((run) => run.run_id)).toEqual(["shadow.run.batch.001", "shadow.run.batch.002"]);
    expect(replay.map((run) => run.run_sha256)).toEqual(scheduled.map((run) => run.run_sha256));
    expect(() => first.control.scheduleBatch({ ...input, runs: input.runs.slice(0, 1) })).toThrow("SHADOW_IDEMPOTENCY_CONFLICT");
  });

  it("blocks all real inactive slots with zero money, Findings and reports", async () => {
    const { control, definition } = plane("real_inactive");
    const run = control.schedule({ definition_id: definition.definition_id, run_id: "shadow.run.real.001", idempotency_key: "shadow-schedule-real-0001" });
    const completed = await control.execute(run.run_id);
    expect(completed.slots).toHaveLength(7);
    for (const slot of completed.slots) {
      for (const result of [slot.baseline, slot.candidate]) expect(result).toMatchObject({ status: "blocked_legal_readiness", amount: null, finding_count: 0, customer_report_count: 0 });
      expect(slot.taxonomy).toBe("blocked");
    }
    expect(completed.blocker_codes).toEqual(expect.arrayContaining(["LEGAL_SOURCE_CORPUS_INCOMPLETE", "REAL_RULES_INACTIVE", "SHADOW_PROMOTION_THRESHOLDS_UNSET"]));
  });

  it("supports revision-guarded cancel/resume and failed-run retry", async () => {
    const first = plane();
    const queued = first.control.schedule({ definition_id: first.definition.definition_id, run_id: "shadow.run.cancel.001", idempotency_key: "shadow-schedule-cancel-0001" });
    const cancelled = first.control.cancel({ run_id: queued.run_id, expected_revision: queued.revision, idempotency_key: "shadow-cancel-0001" });
    const resumed = first.control.resume({ run_id: queued.run_id, expected_revision: cancelled.revision, idempotency_key: "shadow-resume-0001" });
    expect((await first.control.execute(resumed.run_id)).state).toBe("completed");

    const failing = plane("synthetic_test", new SyntheticMechanicsShadowEvaluator(1));
    const initial = failing.control.schedule({ definition_id: failing.definition.definition_id, run_id: "shadow.run.retry.001", idempotency_key: "shadow-schedule-retry-0001" });
    const failed = await failing.control.execute(initial.run_id);
    expect(failed.state).toBe("failed");
    const retried = failing.control.retry({ run_id: failed.run_id, expected_revision: failed.revision, idempotency_key: "shadow-retry-0001" });
    expect(retried.attempt).toBe(2);
    expect((await failing.control.execute(retried.run_id)).state).toBe("completed");
  });

  it("is ordering/process stable, append-only audited and makes no network calls", async () => {
    const definition = buildSyntheticShadowDefinition();
    const definitionContent = unsignedDefinition(definition);
    const reordered = createShadowDefinition({ ...definitionContent, topics: [...definition.topics].reverse(), bundles: [...definition.bundles].reverse() });
    expect(reordered.definition_sha256).toBe(definition.definition_sha256);
    const fetchSpy = vi.fn(() => { throw new Error("network forbidden"); });
    vi.stubGlobal("fetch", fetchSpy);
    const first = new OfflineShadowControlPlane({ flags: ENABLED, evaluator: new SyntheticMechanicsShadowEvaluator(), now: NOW });
    const second = new OfflineShadowControlPlane({ flags: ENABLED, evaluator: new SyntheticMechanicsShadowEvaluator(), now: NOW });
    first.registerDefinition(definition); second.registerDefinition(definition);
    const firstRun = await first.execute(first.schedule({ definition_id: definition.definition_id, run_id: "shadow.run.restart.001", idempotency_key: "shadow-restart-0001" }).run_id);
    const secondRun = await second.execute(second.schedule({ definition_id: definition.definition_id, run_id: "shadow.run.restart.001", idempotency_key: "shadow-restart-0001" }).run_id);
    expect(firstRun.run_sha256).toBe(secondRun.run_sha256);
    expect(fetchSpy).not.toHaveBeenCalled();
    const audit = first.auditEvents();
    expect(audit.every((event, index) => index === 0 ? event.prior_event_sha256 === null : event.prior_event_sha256 === audit[index - 1].event_sha256)).toBe(true);
  });
});
