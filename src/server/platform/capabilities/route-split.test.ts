// L9-3 / D3 and L9-5 / D4. The split is complete — every dispatcher root and
// every route file assigned, nothing defaulting into the open half — and it
// is proven against `main` itself: every route file `main` carries is
// product, every route file this branch added is engine unless it is listed
// as product with its own reason.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTE_FILE_PATTERN, ROUTE_SPLIT, engineAssignments, productAssignments, routeHalfOf, unassignedDispatcherRoots } from "./route-split.ts";
import { STABLE_PRODUCT_DISPATCHER_ROOTS } from "./stable-entrypoint-runtime.ts";

const MAIN = "main";

function routeFilesOf(revision: string): string[] {
  const result = spawnSync("git", ["ls-tree", "-r", revision, "--name-only"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ROUTE_SPLIT_GIT_LS_TREE_FAILED:${revision}:${result.stderr}`);
  return result.stdout.split(/\r?\n/u).filter((line) => ROUTE_FILE_PATTERN.test(line)).sort();
}

describe("the product/engine route split (D3)", () => {
  it("assigns every dispatcher root the inventory knows, and knows nothing the inventory does not", () => {
    expect(unassignedDispatcherRoots()).toEqual([]);
    const roots = new Set(STABLE_PRODUCT_DISPATCHER_ROOTS.map((entry) => entry.entrypoint_id));
    for (const entry of ROUTE_SPLIT) expect(roots.has(entry.entrypoint_id), entry.entrypoint_id).toBe(true);
    expect(ROUTE_SPLIT).toHaveLength(STABLE_PRODUCT_DISPATCHER_ROOTS.length);
    expect(new Set(ROUTE_SPLIT.map((entry) => entry.entrypoint_id)).size).toBe(ROUTE_SPLIT.length);
  });

  it("assigns every route file under src/app at HEAD exactly once, and every assigned file exists", () => {
    const files = routeFilesOf("HEAD");
    const assigned = ROUTE_SPLIT.map((entry) => entry.route_file).filter((file): file is string => file !== null).sort();
    expect(assigned).toEqual(files);
    for (const file of assigned) expect(existsSync(file), file).toBe(true);
    expect(ROUTE_SPLIT.filter((entry) => entry.route_file === null).map((entry) => entry.entrypoint_id)).toEqual(["CEP-078"]);
  });

  it("every assignment carries a reason in prose, and every product route a probe", () => {
    for (const entry of ROUTE_SPLIT) {
      expect(entry.reason.length, entry.entrypoint_id).toBeGreaterThan(30);
      expect(entry.reason.endsWith("."), entry.entrypoint_id).toBe(true);
      if (entry.half === "product") expect(entry.probes?.length ?? 0, entry.entrypoint_id).toBeGreaterThan(0);
      else expect(entry.probes, entry.entrypoint_id).toBeUndefined();
    }
    expect(productAssignments()).toHaveLength(20);
    expect(engineAssignments()).toHaveLength(7);
  });

  it("an unassigned id has no half", () => {
    expect(routeHalfOf("CEP-999")).toBeNull();
    expect(routeHalfOf("CEP-024")).toBe("product");
    expect(routeHalfOf("CEP-020")).toBe("engine");
  });
});

describe("the differential against main's own route inventory (D4)", () => {
  const mainFiles = routeFilesOf(MAIN);
  const headFiles = routeFilesOf("HEAD");

  it("main is an ancestor of HEAD, and its route files are all still present", () => {
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", MAIN, "HEAD"], { encoding: "utf8" });
    expect(ancestry.status).toBe(0);
    expect(mainFiles.length).toBeGreaterThan(0);
    for (const file of mainFiles) expect(headFiles.includes(file), file).toBe(true);
  });

  it("every route file main serves is product-classified", () => {
    const byFile = new Map(ROUTE_SPLIT.map((entry) => [entry.route_file, entry]));
    for (const file of mainFiles) {
      const entry = byFile.get(file);
      expect(entry, file).toBeDefined();
      expect(entry?.half, file).toBe("product");
    }
  });

  it("every route file this branch added is engine-classified unless it is listed as product with its own reason", () => {
    const added = headFiles.filter((file) => !mainFiles.includes(file));
    const byFile = new Map(ROUTE_SPLIT.map((entry) => [entry.route_file, entry]));
    // Nothing added on this branch is product today; a future product route
    // must be named here, with its reason, to pass.
    const productAddedOnBranch: Record<string, string> = {};
    for (const file of added) {
      const entry = byFile.get(file);
      expect(entry, file).toBeDefined();
      if (entry?.half === "product") {
        expect(productAddedOnBranch[file], `${file} is product but was added on this branch: list it with a reason`).toBeDefined();
        expect(entry.reason).toBe(productAddedOnBranch[file]);
      } else {
        expect(entry?.half, file).toBe("engine");
      }
    }
    expect(added.length).toBeGreaterThan(0);
  });

  it("a product route's file on HEAD differs from main's only by the guard, and imports nothing from the engine", () => {
    const enginePattern = /from\s+"(?:@\/server\/engine|@\/engine|@\/server\/product\/(?:operations|portal|internal-ops|legal|durable-governance)|\.\.\/.*(?:legal|shadow|operations|portal|ground-truth))/u;
    for (const file of mainFiles) {
      const head = readFileSync(file, "utf8");
      expect(enginePattern.test(head), file).toBe(false);
      const diff = spawnSync("git", ["diff", "--numstat", MAIN, "HEAD", "--", file], { encoding: "utf8" }).stdout.trim();
      if (diff === "") continue;
      // The guard: an import or two, the try/catch around the guard call, and for /api/health the runtime constant.
      const [added, removed] = diff.split(/\s+/u).map(Number);
      expect(added, `${file}: ${diff}`).toBeLessThanOrEqual(12);
      expect(removed, `${file}: ${diff}`).toBeLessThanOrEqual(2);
      expect(head).toMatch(/guardStable(?:Http|App)Entrypoint\("CEP-\d{3}"/u);
    }
  });
});
