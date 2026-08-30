import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../persistence/canonical";
import { LocalDurableJobQueue } from "./durable-job-queue";

function job(index: number, maxAttempts = 3) {
  const payload = { synthetic_job: index };
  return {
    job_id: `job:synthetic:${index.toString().padStart(2, "0")}`,
    tenant_id: "tenant:synthetic:001",
    case_id: "case:synthetic:001",
    job_kind: "analysis_stage",
    idempotency_key: `analysis:${index}`,
    payload,
    payload_sha256: canonicalSha256(payload),
    pinned_version_sha256s: ["a".repeat(64)],
    max_attempts: maxAttempts,
    available_at_ms: 0,
  } as const;
}

describe("durable jobs, leases and fencing", () => {
  it("lets 16 workers atomically claim 16 distinct jobs", async () => {
    const queue = new LocalDurableJobQueue();
    await Promise.all(Array.from({ length: 16 }, (_, index) => queue.enqueue(job(index))));
    const claims = await Promise.all(Array.from({ length: 16 }, (_, index) => queue.claim(`worker:${index}`, 0, 100)));
    expect(new Set(claims.flat().map((claimed) => claimed.job_id)).size).toBe(16);
    expect(queue.countByState("leased")).toBe(16);
  });

  it("rejects stale heartbeat, terminal transition and logical effect after lease reclaim", async () => {
    const queue = new LocalDurableJobQueue();
    await queue.enqueue(job(1));
    const first = (await queue.claim("worker:a", 0, 10))[0];
    const running = await queue.start(first.job_id, "worker:a", first.fencing_token, 1);
    const reclaimed = (await queue.claim("worker:b", 10, 10))[0];
    expect(reclaimed.fencing_token).toBeGreaterThan(running.fencing_token);
    await expect(queue.heartbeat(first.job_id, "worker:a", running.fencing_token, 11, 10)).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
    await expect(queue.succeed(first.job_id, "worker:a", running.fencing_token, 11, "b".repeat(64))).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
    await queue.start(reclaimed.job_id, "worker:b", reclaimed.fencing_token, 11);
    await expect(queue.succeed(reclaimed.job_id, "worker:b", reclaimed.fencing_token, 12, "b".repeat(64))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("recovers retry state across restart without changing pinned versions", async () => {
    const queue = new LocalDurableJobQueue();
    await queue.enqueue(job(2));
    const claimed = (await queue.claim("worker:a", 0, 10))[0];
    await queue.start(claimed.job_id, "worker:a", claimed.fencing_token, 1);
    await queue.fail(claimed.job_id, "worker:a", claimed.fencing_token, 2, 8);
    const restarted = new LocalDurableJobQueue(queue.snapshot());
    expect(restarted.get(claimed.job_id)?.pinned_version_sha256s).toEqual(["a".repeat(64)]);
    const reclaimed = (await restarted.claim("worker:b", 10, 10))[0];
    expect(reclaimed.attempt_count).toBe(2);
  });

  it("rejects work after lease expiry and dead-letters an exhausted expired attempt", async () => {
    const queue = new LocalDurableJobQueue();
    await queue.enqueue(job(20, 1));
    const claimed = (await queue.claim("worker:a", 0, 10))[0];
    await expect(queue.start(claimed.job_id, "worker:a", claimed.fencing_token, 10)).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
    expect(await queue.claim("worker:b", 10, 10)).toHaveLength(0);
    expect(queue.get(claimed.job_id)?.state).toBe("dead_letter");
  });

  it("keeps dead-letter and cancellation history immutable and replays into a new job", async () => {
    const queue = new LocalDurableJobQueue();
    await queue.enqueue(job(3, 1));
    const claimed = (await queue.claim("worker:a", 0, 10))[0];
    await queue.start(claimed.job_id, "worker:a", claimed.fencing_token, 1);
    const dead = await queue.fail(claimed.job_id, "worker:a", claimed.fencing_token, 2, 0);
    expect(dead.state).toBe("dead_letter");
    const before = queue.events(dead.job_id);
    const replay = await queue.replayDeadLetter(dead.job_id, "job:synthetic:replay", "analysis:replay", 3);
    expect(replay).toMatchObject({ state: "queued", replayed_from_job_id: dead.job_id });
    expect(queue.get(dead.job_id)?.state).toBe("dead_letter");
    expect(queue.events(dead.job_id)).toEqual(before);
    await queue.cancel(replay.job_id, 4);
    expect(queue.get(replay.job_id)?.state).toBe("cancelled");
  });

  it("deduplicates enqueue and rejects changed payload under the same key", async () => {
    const queue = new LocalDurableJobQueue();
    const first = await queue.enqueue(job(4));
    expect(await queue.enqueue(job(4))).toEqual(first);
    const changed = { ...job(4), payload: { synthetic_job: 999 }, payload_sha256: canonicalSha256({ synthetic_job: 999 }) };
    await expect(queue.enqueue(changed)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" });
  });
});
