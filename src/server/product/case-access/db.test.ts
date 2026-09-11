// The seam between the product's services and their store had one silent
// failure mode, and this file exists because it happened: the allowlist in
// `db.ts` listed the two function families that existed when it was written,
// the unit tests all ran against fakes that never consult it, and two waves of
// new functions (`case_request_*`, `case_documents_list`) passed every test
// while being unreachable in production and on the local runtime.
//
// So the first test does not check the regex against a hand-written list. It
// reads the product's own source, collects every function name actually passed
// to `rpc`, and asserts the real adapters accept each one — which means a
// future function named outside the families fails here, in a unit test,
// instead of in a 503 on a screen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postgresCaseAccessDb, supabaseCaseAccessDb } from "./db.ts";

const PRODUCT_ROOT = join(process.cwd(), "src", "server", "product");
// `[\s\S]` rather than the dotall flag: a generic argument often spans lines,
// and this project's target predates `s`.
const RPC_CALL = /\brpc(?:<[\s\S]{0,600}?>)?\(\s*(['"])([a-z][a-z0-9_]+)\1/gu;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "db.ts" && name !== "fake-db.ts" ? [path] : [];
  });
}

function calledFunctionNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(PRODUCT_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RPC_CALL)) names.add(match[2]!);
  }
  return [...names].sort();
}

describe("case access store adapters", () => {
  it("preserves safe upload conflicts without exposing database error details", async () => {
    for (const message of ["UPLOAD_VERSION_CONFLICT", "permission denied for private customer@example.invalid"]) {
      const store = supabaseCaseAccessDb({ async rpc() { return { data: null, error: { code: "P0001", message } }; } });
      await expect(store.rpc("case_documents_upload_commit", {})).rejects.toThrow(
        `CASE_ACCESS_DB_RPC_FAILED:case_documents_upload_commit:${message.startsWith("UPLOAD_") ? message : "rpc_failed"}`,
      );
    }
  });

  it("accepts every function name the product actually calls", async () => {
    const names = calledFunctionNames();
    // A collector that found nothing would make this test pass vacuously.
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("case_request_open");
    expect(names).toContain("case_documents_list");
    expect(names).toContain("june2026_regular_report_artifact");

    const queries: string[] = [];
    const postgres = postgresCaseAccessDb({
      async query(text: string) {
        queries.push(text);
        return { rows: [] };
      },
    });
    const supabase = supabaseCaseAccessDb({
      async rpc() {
        return { data: [], error: null };
      },
    });

    for (const name of names) {
      await expect(postgres.rpc(name, { target_case: "c1" })).resolves.toEqual([]);
      await expect(supabase.rpc(name, { target_case: "c1" })).resolves.toEqual([]);
    }
    expect(queries).toHaveLength(names.length);
  });

  it("refuses a function name outside the allowed families", async () => {
    const postgres = postgresCaseAccessDb({ async query() { return { rows: [] }; } });
    const supabase = supabaseCaseAccessDb({ async rpc() { return { data: [], error: null }; } });
    for (const store of [postgres, supabase]) {
      await expect(store.rpc("drop_everything", {})).rejects.toThrow("CASE_ACCESS_DB_FUNCTION_UNKNOWN:drop_everything");
      // A plausible-looking name in no allowed family: `case_report_*` is a
      // family and `case_payment_*` is not, so the guard is about the list and
      // not about the prefix looking familiar.
      await expect(store.rpc("case_payment_refund", {})).rejects.toThrow("CASE_ACCESS_DB_FUNCTION_UNKNOWN");
      for (const name of ["june2026_regular_authority", "june2026_regular_report_artifact_extra", "june2026_regular_report_artifact;drop"]) {
        await expect(store.rpc(name, {})).rejects.toThrow("CASE_ACCESS_DB_FUNCTION_UNKNOWN");
      }
    }
  });

  it("passes arguments by name and refuses an argument name it cannot interpolate", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const postgres = postgresCaseAccessDb({
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values: values ?? [] });
        return { rows: [] };
      },
    });
    await postgres.rpc("case_request_open", { target_case: "c1", target_code: "document_missing" });
    expect(queries[0]!.text).toBe("select * from public.case_request_open(target_case => $1, target_code => $2)");
    expect(queries[0]!.values).toEqual(["c1", "document_missing"]);

    await expect(postgres.rpc("case_request_open", { "target; drop": 1 })).rejects.toThrow("CASE_ACCESS_DB_ARGUMENT_UNKNOWN");
  });

  it("reads a scalar-returning function the same way through both adapters", async () => {
    const postgres = postgresCaseAccessDb({
      async query() { return { rows: [{ case_access_identity_upsert: "id-1" }] }; },
    });
    const supabase = supabaseCaseAccessDb({
      async rpc() { return { data: "id-1", error: null }; },
    });
    await expect(postgres.rpc("case_access_identity_upsert", {})).resolves.toEqual([{ value: "id-1" }]);
    await expect(supabase.rpc("case_access_identity_upsert", {})).resolves.toEqual([{ value: "id-1" }]);
  });
});


it("maps only the explicit source visibility refusal to absence in both adapters",async()=>{
 for(const message of ['REPORT_SOURCE_FORBIDDEN','REPORT_SOURCE_MISSING','connection failed']){
  const error=Object.assign(Error(message),{code:'P0001'});
  const stores=[postgresCaseAccessDb({async query(){throw error;}}),supabaseCaseAccessDb({async rpc(){return {data:null,error};}})];
  for(const store of stores){
   if(message==='REPORT_SOURCE_FORBIDDEN')await expect(store.rpc('case_report_source',{})).resolves.toEqual([]);
   else await expect(store.rpc('case_report_source',{})).rejects.toThrow();
   await expect(store.rpc('case_report_review_source',{})).rejects.toThrow();
  }
 }
});

it.each([
 ['REVIEW_REQUEST_SOURCE_CHANGED','REQUEST_FIELD_SOURCE_CHANGED'],
 ['REVIEW_REQUEST_ANSWER_INVALID','REQUEST_ANSWER_INVALID'],
 ['REVIEW_REQUEST_CLOSED','REQUEST_EDIT_CLOSED'],
 ['REVIEW_REQUEST_FORBIDDEN','REQUEST_FIELD_FORBIDDEN'],
])('preserves the exact locked review refusal %s consistently in both adapters',async(message,safe)=>{
 const error=Object.assign(Error(message),{code:'P0001',detail:'private database detail'});
 const stores=[postgresCaseAccessDb({async query(){throw error;}}),supabaseCaseAccessDb({async rpc(){return {data:null,error};}})];
 for(const store of stores)for(const fn of ['case_request_answer_identified','case_request_edit','case_request_review_states'])
  await expect(store.rpc(fn,{})).rejects.toThrow(`CASE_ACCESS_DB_RPC_FAILED:${fn}:${safe}`);
});

it.each([
 ['case_report_source','P0001','REVIEW_REQUEST_SOURCE_CHANGED'],
 ['case_request_answer_identified','08006','REVIEW_REQUEST_SOURCE_CHANGED'],
 ['case_request_answer_identified','P0001','REVIEW_REQUEST_SOURCE_CHANGED: private@example.invalid'],
 ['case_request_answer_identified','P0001','REVIEW_REQUEST_TARGET_INVALID'],
])('does not broaden review refusal mapping for %s/%s/%s',async(fn,code,message)=>{
 const error=Object.assign(Error(message),{code});
 const postgres=postgresCaseAccessDb({async query(){throw error;}}),supabase=supabaseCaseAccessDb({async rpc(){return {data:null,error};}});
 await expect(postgres.rpc(fn,{})).rejects.toBe(error);
 await expect(supabase.rpc(fn,{})).rejects.toThrow(`CASE_ACCESS_DB_RPC_FAILED:${fn}:rpc_failed`);
});
