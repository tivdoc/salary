import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SALARY_GRANT_BLOCK_REASON,
  SALARY_GRANT_CALLER_FILES,
  SALARY_GRANT_DISPOSITIONS,
  SALARY_GRANT_UNBLOCK_PRECONDITION,
} from "./salary-grant-disposition.ts";

// E2-5. The disposition is only worth anything if it is still true, so every
// claim in it is checked against the repository rather than believed.

const REPO_ROOT = path.resolve(".");

function grep(pattern: string, scope: string): string[] {
  try {
    return execSync(`git grep -n --fixed-strings ${JSON.stringify(pattern)} -- ${scope}`,
      { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

describe("E2-5 salary grant disposition", () => {
  it("records exactly eight functions, each individually, none batched", () => {
    expect(SALARY_GRANT_DISPOSITIONS).toHaveLength(8);
    expect(new Set(SALARY_GRANT_DISPOSITIONS.map((entry) => entry.function_name)).size).toBe(8);
    for (const entry of SALARY_GRANT_DISPOSITIONS) {
      expect(entry.disposition, entry.function_name).toBe("cannot_move");
      // Each carries its own caller and its own consequence. A shared reason is
      // fine — it really is the same structural block — but a shared "what
      // breaks" would mean nobody checked them one at a time.
      expect(entry.caller_file, entry.function_name).not.toBe("");
      expect(entry.what_breaks_if_revoked.length, entry.function_name).toBeGreaterThan(40);
    }
    expect(new Set(SALARY_GRANT_DISPOSITIONS.map((entry) => entry.what_breaks_if_revoked)).size).toBe(8);
  });

  it("every recorded function still has its service_role grant in the migrations", async () => {
    // The grant spans two lines — `grant execute on function public.x(args)`
    // then `to ... service_role` — so this reads the files rather than
    // line-grepping, which would miss it and quietly pass a weaker check.
    const files = [...new Set(grep("_salary_", "supabase/migrations").map((line) => line.split(":")[0]))];
    expect(files.length).toBeGreaterThan(0);
    const combined = (await Promise.all(files.map(async (file) =>
      (await readFile(path.join(REPO_ROOT, file), "utf8")).replaceAll("\r\n", "\n")))).join("\n");
    for (const entry of SALARY_GRANT_DISPOSITIONS) {
      const granted = new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${entry.function_name}\\s*\\([^)]*\\)[^;]*service_role`,
        "iu",
      );
      expect(granted.test(combined), `${entry.function_name} service_role grant not found`).toBe(true);
    }
  });

  it("every recorded caller file still calls its function, and still through supabase.rpc", async () => {
    for (const entry of SALARY_GRANT_DISPOSITIONS) {
      const hits = grep(entry.function_name, entry.caller_file);
      expect(hits.length, `${entry.function_name} not called from ${entry.caller_file}`).toBeGreaterThan(0);
    }
    // The reason the eight cannot move is that these four files talk to
    // Postgres over PostgREST. If one of them ever opens a direct connection,
    // that file's functions become movable and this test says so.
    for (const file of SALARY_GRANT_CALLER_FILES) {
      const source = (await readFile(path.join(REPO_ROOT, file), "utf8")).replaceAll("\r\n", "\n");
      expect(source, file).toContain(".rpc(");
      expect(source, `${file} now opens a direct Postgres connection — the eight grants may be movable`)
        .not.toMatch(/new\s+(?:pg\.)?Client\(|NodePostgresConnectionFactory/u);
    }
  });

  it("every caller still authenticates with the service-role key, which is why the role cannot narrow", async () => {
    const admin = (await readFile(path.join(REPO_ROOT, "src/lib/supabase-admin.ts"), "utf8"))
      .replaceAll("\r\n", "\n");
    expect(admin).toContain("SERVICE_ROLE");
    for (const file of SALARY_GRANT_CALLER_FILES) {
      const source = (await readFile(path.join(REPO_ROOT, file), "utf8")).replaceAll("\r\n", "\n");
      expect(source, file).toMatch(/getSupabaseAdmin\s*\(/u);
    }
  });

  it("states the precondition for revisiting this, so a later session need not re-derive it", () => {
    expect(SALARY_GRANT_BLOCK_REASON).toContain("service_role");
    expect(SALARY_GRANT_UNBLOCK_PRECONDITION).toContain("PostgREST");
    // No entry claims to have been moved. If one ever is, its grant should be
    // gone from the migrations and it should leave this list entirely.
    expect(SALARY_GRANT_DISPOSITIONS.every((entry) => entry.disposition === "cannot_move")).toBe(true);
  });
});
