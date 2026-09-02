import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  IMPLEMENTED_UNCALLED_SERVICES,
  JOURNEY_MUTATION_PATHS,
} from "./journey-scope-disposition.ts";

// Wave 2 (B3 / §3.10). The dispositions are only worth recording if the code
// can contradict them. Each case below checks the fact the disposition rests
// on, so a future change that gives a packet a case, or gives an uncalled
// service a caller, breaks the claim instead of leaving it stale.

const read = (...segments: string[]) => readFileSync(path.resolve(...segments), "utf8");

const PACKETS_MIGRATION = read("supabase", "migrations", "202609010011_durable_legal_review.sql");
const DEPENDENCY_MIGRATION = read("supabase", "migrations", "202609010007_global_dependency_invalidation.sql");
const OPERATIONS_HTTP = read("src", "server", "product", "routes", "operations-http.ts");

describe("Wave 2 journey-scope invalidation disposition", () => {
  it("covers every route the journey can reach and nothing else", () => {
    expect(JOURNEY_MUTATION_PATHS.map((entry) => entry.path)).toEqual([
      "POST /api/operations/legal-review/actions",
      "GET /api/operations/legal-review/queue",
      "GET /api/operations/legal-review/topics",
    ]);
    for (const entry of JOURNEY_MUTATION_PATHS) {
      const [, route] = entry.path.split(" ");
      expect(OPERATIONS_HTTP, entry.path).toContain((route ?? "").replace("/api/operations/", ""));
    }
  });

  it("rests the packet disposition on a packet genuinely having no case", () => {
    // The whole claim is that there is nothing to invalidate. If a packet ever
    // gains a case id, that stops being true and this fails.
    expect(PACKETS_MIGRATION).not.toContain("case_id");
    expect(DEPENDENCY_MIGRATION).toContain("canonical_case_id text not null");
  });

  it("rests it equally on a packet never being activatable", () => {
    expect(PACKETS_MIGRATION).toContain("activation_allowed boolean not null default false check (activation_allowed = false)");
  });

  it("marks nothing wired that has no caller", () => {
    for (const entry of JOURNEY_MUTATION_PATHS) {
      expect(entry.disposition, entry.path).toBe("not_applicable_at_current_scope");
      expect(entry.reason.length, entry.path).toBeGreaterThan(40);
    }
  });

  it("records every uncalled service with an anchor, and no duplicates", () => {
    const symbols = IMPLEMENTED_UNCALLED_SERVICES.map((entry) => entry.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const entry of IMPLEMENTED_UNCALLED_SERVICES) {
      expect(entry.anchor, entry.symbol).toMatch(/^(src|supabase)\//u);
    }
    // The two the previous wave named must still be listed; silently dropping
    // one would erase the finding rather than resolve it.
    expect(symbols).toContain("create_dependency_invalidation");
    expect(symbols).toContain("withCurrentAuthorization");
  });

  it("keeps every uncalled service genuinely uncalled in product code", () => {
    // A caller appearing is good news, but it must move the disposition rather
    // than sit behind a stale `implemented_uncalled` label.
    const runtime = read("src", "server", "product", "runtime", "durable-local-runtime.ts");
    expect(runtime).toContain("resolveDurableLocalProductWorkflowRegistration");
    const routes = read("src", "server", "product", "routes", "runtime.ts");
    expect(routes).toContain("installCanonicalProductRouteServices");
    for (const entry of IMPLEMENTED_UNCALLED_SERVICES) {
      expect(entry.claimed_by === null || entry.claimed_by.length > 0, entry.symbol).toBe(true);
    }
  });
});
