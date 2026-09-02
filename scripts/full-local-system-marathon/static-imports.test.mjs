import { describe, expect, it } from "vitest";

import { addedSourceByPath, findStaticImports, STATIC_IMPORT_SCHEMA } from "./static-imports.mts";

const specifiers = (source) => findStaticImports(source).map((entry) => entry.specifier);

describe("V0.10.4 static import recognizer", () => {
  it("exposes a pinned schema name", () => {
    expect(STATIC_IMPORT_SCHEMA).toBe("tivdoc-static-import-recognizer-v0.10.4");
  });

  it("recognizes a single-line import exactly as the previous scanner did", () => {
    expect(specifiers('import { a } from "./fixtures.ts";')).toEqual(["./fixtures.ts"]);
  });

  it("recognizes a multiline named import, which is the defect this closes", () => {
    const source = [
      "import {",
      "  ContentAddressedIdPort,",
      "  FixtureReportBuilder,",
      "} from \"../../../engine/case-analysis/fixture-ports.ts\";",
    ].join("\n");
    const found = findStaticImports(source);
    expect(found).toHaveLength(1);
    expect(found[0].specifier).toBe("../../../engine/case-analysis/fixture-ports.ts");
    expect(found[0].statement).toContain("FixtureReportBuilder");
    expect(found[0].statement.split("\n")).toHaveLength(4);
  });

  it("recognizes default, namespace, type-only and bare forms", () => {
    expect(specifiers('import defaultExport from "./a.ts";')).toEqual(["./a.ts"]);
    expect(specifiers('import * as namespace from "./b.ts";')).toEqual(["./b.ts"]);
    expect(specifiers('import type { T } from "./c.ts";')).toEqual(["./c.ts"]);
    expect(specifiers('import "./side-effect.ts";')).toEqual(["./side-effect.ts"]);
    expect(specifiers("import { a } from './single-quoted.ts';")).toEqual(["./single-quoted.ts"]);
  });

  it("tolerates unusual whitespace between every token", () => {
    expect(specifiers("import\n  type\n  {\n  T\n  }\n  from\n  \"./spaced.ts\"  ;")).toEqual(["./spaced.ts"]);
  });

  it("finds every import in a file, not only the first", () => {
    const source = [
      'import { a } from "./a.ts";',
      "import {",
      "  b,",
      '} from "./b.ts";',
      'import "./c.ts";',
    ].join("\n");
    expect(specifiers(source)).toEqual(["./a.ts", "./b.ts", "./c.ts"]);
  });

  it("never reports a dynamic import expression", () => {
    expect(specifiers('const mod = await import("./fixtures.ts");')).toEqual([]);
    expect(specifiers('void import(\n  "./fixtures.ts"\n);')).toEqual([]);
  });

  it("never reports import.meta", () => {
    expect(specifiers('const url = import.meta.url; // "./fixtures.ts"')).toEqual([]);
  });

  it("never reports an import inside a line or block comment", () => {
    expect(specifiers('// import { a } from "./fixtures.ts";')).toEqual([]);
    expect(specifiers('/* import { a } from "./fixtures.ts"; */')).toEqual([]);
    expect(specifiers([
      "/*",
      ' import {',
      '   a,',
      ' } from "./fixtures.ts";',
      "*/",
    ].join("\n"))).toEqual([]);
  });

  it("never reports an import written inside a string or template literal", () => {
    expect(specifiers('const text = "import { a } from \\"./fixtures.ts\\";";')).toEqual([]);
    expect(specifiers("const text = `import { a } from \"./fixtures.ts\";`;")).toEqual([]);
  });

  it("does not treat an identifier ending in import as a keyword", () => {
    expect(specifiers('const reimport = 1; const importer = "./fixtures.ts";')).toEqual([]);
  });

  it("keeps a stray apostrophe from swallowing later imports", () => {
    const source = [
      "// it's a comment with an apostrophe",
      'import { a } from "./after.ts";',
    ].join("\n");
    expect(specifiers(source)).toEqual(["./after.ts"]);
  });

  it("still finds real imports that follow a commented-out one", () => {
    const source = [
      '// import { old } from "./old.ts";',
      'import { current } from "./current.ts";',
    ].join("\n");
    expect(specifiers(source)).toEqual(["./current.ts"]);
  });
});

describe("V0.10.4 added-source reconstruction", () => {
  const diff = [
    "diff --git a/src/one.ts b/src/one.ts",
    "+++ b/src/one.ts",
    "@@",
    "+import {",
    "+  Fixture,",
    '+} from "./fixture-ports.ts";',
    "diff --git a/src/two.ts b/src/two.ts",
    "+++ b/src/two.ts",
    "@@",
    '+import { other } from "./other.ts";',
    "-import { removed } from \"./removed.ts\";",
  ].join("\n");

  it("groups added lines per file so multiline statements survive the diff", () => {
    const sources = addedSourceByPath(diff);
    expect([...sources.keys()].sort()).toEqual(["src/one.ts", "src/two.ts"]);
    expect(specifiers(sources.get("src/one.ts") ?? "")).toEqual(["./fixture-ports.ts"]);
  });

  it("excludes removed lines from the reconstructed source", () => {
    const sources = addedSourceByPath(diff);
    expect(specifiers(sources.get("src/two.ts") ?? "")).toEqual(["./other.ts"]);
  });
});
