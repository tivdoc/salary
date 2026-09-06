import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { STABLE_PRODUCT_DISPATCHER_ROOTS } from "./stable-entrypoint-runtime.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

describe("stable product dispatcher capability reachability", () => {
  // Long run 11 found this the expensive way: CEP-106 moved the dispatcher
  // count to 38, every denominator in the ledger and its tests was updated, and
  // the local runtime still refused to start because it carries its OWN copy of
  // the number in a startup proof no unit test read. The journeys caught it as
  // five 500s.
  //
  // The number is deliberately repeated in several places — a startup proof
  // that read the ledger would prove nothing about the ledger — so what has to
  // be checked is that the copies agree. This reads the source for every
  // hard-coded comparison against the array's length and asserts each one.
  it("agrees with every hard-coded copy of the dispatcher denominator", () => {
    const pattern = /STABLE_PRODUCT_DISPATCHER_ROOTS\.length\s*!==\s*(\d+)/gu;
    const found: Array<{ file: string; declared: number }> = [];
    const walkSource = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walkSource(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
    for (const file of walkSource(join(repositoryRoot, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        found.push({ file: relative(repositoryRoot, file).replaceAll("\\", "/"), declared: Number(match[1]) });
      }
    }
    // A collector that found nothing would make this pass while the copies drift.
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const entry of found) {
      expect(entry.declared, entry.file).toBe(STABLE_PRODUCT_DISPATCHER_ROOTS.length);
    }
  });

  it("maps the exact 37 live Next roots plus the canonical route registrar", () => {
    const nextRoots = STABLE_PRODUCT_DISPATCHER_ROOTS.filter(
      (entry) => entry.kind === "app_route" || entry.kind === "api_route",
    );
    const registrar = STABLE_PRODUCT_DISPATCHER_ROOTS.filter((entry) => entry.entrypoint_id === "CEP-078");
    expect(STABLE_PRODUCT_DISPATCHER_ROOTS).toHaveLength(38);
    expect(nextRoots).toHaveLength(37);
    expect(registrar).toHaveLength(1);
    expect(new Set(STABLE_PRODUCT_DISPATCHER_ROOTS.map((entry) => entry.entrypoint_id)).size).toBe(38);

    const liveNextRoots = walk(join(repositoryRoot, "src/app"))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))
      .filter((path) => /(?:^|\/)(?:page\.tsx|route\.ts|robots\.ts|sitemap\.ts|opengraph-image\.tsx)$/u.test(path))
      .sort();
    expect(liveNextRoots).toEqual(nextRoots.map((entry) => entry.source_path).sort());
  });

  it("proves every app dispatcher invokes its exact request-time capability guard", () => {
    const appRoots = STABLE_PRODUCT_DISPATCHER_ROOTS.filter((entry) => entry.kind === "app_route");
    expect(appRoots).toHaveLength(18);
    for (const entry of appRoots) {
      const source = sourceAt(entry.source_path);
      expect(source.text, entry.entrypoint_id).toContain(`guardStableAppEntrypoint("${entry.entrypoint_id}")`);
      const defaultFunction = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true,
      );
      expect(defaultFunction?.body?.getText(source), entry.entrypoint_id).toContain(
        `guardStableAppEntrypoint("${entry.entrypoint_id}")`,
      );
    }
  });

  it("proves every exported HTTP method reaches its exact bounded request guard", () => {
    const apiRoots = STABLE_PRODUCT_DISPATCHER_ROOTS.filter((entry) => entry.kind === "api_route");
    expect(apiRoots).toHaveLength(19);
    for (const entry of apiRoots) {
      const source = sourceAt(entry.source_path);
      const expected = `guardStableHttpEntrypoint("${entry.entrypoint_id}"`;
      expect(source.text, entry.entrypoint_id).toContain(expected);
      const sharedHandle = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "handle",
      );
      const sharedHandleIsGuarded = sharedHandle?.body?.getText(source).includes(expected) === true;
      const methods = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement)
        && statement.name !== undefined
        && HTTP_METHODS.has(statement.name.text)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
      );
      expect(methods.length, entry.entrypoint_id).toBeGreaterThan(0);
      for (const method of methods) {
        const body = method.body?.getText(source) ?? "";
        expect(body.includes(expected) || (sharedHandleIsGuarded && body.includes("handle(")), `${entry.entrypoint_id}:${method.name?.text}`).toBe(true);
      }
    }
  });

  it("proves the 33rd root installs and immediately verifies the route registrar guard", () => {
    const source = sourceAt("src/server/product/routes/runtime.ts");
    const registrar = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "installCanonicalProductEntrypointCapabilities",
    );
    const body = registrar?.body?.getText(source) ?? "";
    expect(body).toContain("installStableEntrypointRuntime(runtime)");
    expect(body).toContain('assertStableEntrypointCapability("CEP-078")');
  });
});

function sourceAt(path: string): ts.SourceFile {
  const text = readFileSync(join(repositoryRoot, path), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
