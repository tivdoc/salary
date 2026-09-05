// L8-2 / D1. The governance-writer inventory, DERIVED from the scripts rather
// than declared beside them.
//
// Long run 7 recorded a false pass: `draft-shadow-run-v1.mts` re-seeds the
// reference tenant's system session (`seedSessions(TENANT, …)`, `TENANT`
// imported from the file that owns it), and the hand-written inventory said
// `synthetic-proof`. The two checks that should have caught it read only the
// hand-entered fields: one looked for the reason, the other for the literal
// spelled inline — and an imported constant is not a literal. This module
// resolves, statically, where each write actually goes:
//
//   - every call to a helper that takes a tenant (`seedSessions`,
//     `registerReviewerIdentity`, `importPoolPBatch` and its default target),
//   - every governance / identity SQL function call, through the first
//     parameter of the statement (or the session id it revokes),
//   - every repository constructed with a tenant (`new Postgres…Repository(ctx, tenant)`),
//
// and follows the expression one import hop: a local constant, a constant
// exported by another file in the directory (a re-export counts as the hop), a
// default parameter, a function parameter (then: the file's own call sites).
//
// A tenant it cannot decide is `undecidable`, and the test fails on it. A
// guard that guesses eventually waves something through; this one just did,
// so it no longer guesses.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const REFERENCE = "reference";
export const SYNTHETIC = "synthetic-proof";
export const OWN = "own-per-run-tenant";
export const PARAMETERISED = "parameterised-helper";
export const UNDECIDABLE = "undecidable";

const REFERENCE_LITERAL = "legal.reference.il";
const SYNTHETIC_LITERAL = "legal.synthetic.proof";

/** SQL functions that change governance or identity state; the tenant is the first parameter. */
export const SQL_WRITE_FUNCTIONS = Object.freeze([
  "governance_parameter_import", "governance_parameter_supersede", "governance_parameter_attestation_append",
  "governance_legal_open_decision_register", "governance_legal_open_decision_withdraw",
  "governance_legal_open_decision_mark_synthetic", "governance_legal_open_decision_annotate",
  "legal_operations_execution_trace_append",
  "governance_legal_instrument_selection_register", "governance_legal_instrument_selection_supersede",
  "governance_reviewer_append", "governance_key_challenge_append",
  "governance_trust_organization_append", "governance_trust_policy_append",
  "governance_reviewer_key_register",
  "governance_rulespec_import", "governance_legal_observation_import", "governance_legal_review_observation_block_append",
  "governance_legal_review_packet_enqueue", "governance_legal_review_action_append", "governance_work_enqueue",
  "governance_gt_manifest_append", "governance_golden_case_set_import",
  "governance_legal_review_observation_supersession_append",
]);
/**
 * A session revocation or rotation names a session, not a tenant: the definer
 * resolves the tenant from the connection's context, which the script sets
 * with `set_config('tivdoc.tenant_id', $1, false)` just before. That call is
 * the tenant of the write.
 */
const SQL_SESSION_FUNCTIONS = Object.freeze(["product_session_revoke", "product_session_rotate", "product_identity_session_register"]);
const TENANT_CONTEXT_SQL = "tivdoc.tenant_id";

/** Helpers that take the tenant: where in the call it sits. */
const HELPERS = Object.freeze({
  seedSessions: { kind: "argument", index: 0 },
  registerReviewerIdentity: { kind: "argument_property", index: 0, property: "tenant" },
  importPoolPBatch: { kind: "argument_property_or_default", index: 3, property: "tenant" },
});
const REPOSITORY_CONSTRUCTOR = /^Postgres[A-Za-z]*Repository$/u;

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function moduleIndex(source, file) {
  const imports = new Map();   // local name -> { file, imported }
  const consts = new Map();    // name -> initializer
  const functions = new Map(); // name -> FunctionDeclaration | ArrowFunction (via const)
  const reexports = new Map(); // exported name -> { file, imported }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const target = resolveSpecifier(file, statement.moduleSpecifier.text);
      for (const element of statement.importClause.namedBindings.elements) {
        imports.set(element.name.text, { file: target, imported: (element.propertyName ?? element.name).text });
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const target = resolveSpecifier(file, statement.moduleSpecifier.text);
      for (const element of statement.exportClause.elements) reexports.set(element.name.text, { file: target, imported: (element.propertyName ?? element.name).text });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          consts.set(declaration.name.text, declaration.initializer);
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) functions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
  }
  return { source, file, imports, consts, functions, reexports };
}

function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(path.dirname(from), specifier);
  return existsSync(target) ? target : null;
}

const indexCache = new Map();
function indexOf(file) {
  if (!indexCache.has(file)) indexCache.set(file, moduleIndex(parse(file), file));
  return indexCache.get(file);
}

function classifyText(text) {
  if (text.includes(REFERENCE_LITERAL)) return REFERENCE;
  if (text.includes(SYNTHETIC_LITERAL)) return SYNTHETIC;
  return OWN;
}

/**
 * The tenant an expression denotes, followed at most `hops` import hops.
 * Returns REFERENCE / SYNTHETIC / OWN / "parameter" / UNDECIDABLE.
 */
function classifyExpression(expression, index, hops = 2, params = new Set()) {
  if (!expression) return UNDECIDABLE;
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression?.(expression)) return classifyExpression(expression.expression, index, hops, params);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return classifyText(expression.text);
  if (ts.isTemplateExpression(expression)) {
    // `tenant.synthetic.gt.${RUN}`: the literal head fixes the namespace, whatever
    // the run id resolves to. `${X}` alone is X. Anything else with a reference
    // span is a reference.
    const spans = expression.templateSpans.map((span) => classifyExpression(span.expression, index, hops, params));
    if (spans.includes(REFERENCE)) return REFERENCE;
    if (expression.head.text !== "") return classifyText(expression.head.text);
    if (expression.templateSpans.length === 1) return spans[0];
    return UNDECIDABLE;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const tenant = expression.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "tenant");
    if (tenant && ts.isPropertyAssignment(tenant)) return classifyExpression(tenant.initializer, index, hops, params);
    const shorthand = expression.properties.find((property) => ts.isShorthandPropertyAssignment(property) && property.name.text === "tenant");
    if (shorthand) return classifyExpression(shorthand.name, index, hops, params);
    return UNDECIDABLE;
  }
  if (ts.isIdentifier(expression)) {
    if (params.has(expression.text)) return "parameter";
    const local = index.consts.get(expression.text);
    if (local) return classifyExpression(local, index, hops, params);
    const imported = index.imports.get(expression.text);
    if (imported) return classifyExport(imported.file, imported.imported, hops - 1);
    return UNDECIDABLE;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const root = expression.expression;
    if (ts.isIdentifier(root)) {
      if (params.has(root.text)) return "parameter";
      const local = index.consts.get(root.text);
      if (local && ts.isObjectLiteralExpression(local)) {
        const property = local.properties.find((candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === expression.name.text);
        if (property && ts.isPropertyAssignment(property)) return classifyExpression(property.initializer, index, hops, params);
      }
      if (local && ts.isCallExpression(local) && ts.isPropertyAccessExpression(local.expression) && local.expression.name.text === "freeze" && local.arguments[0] && ts.isObjectLiteralExpression(local.arguments[0])) {
        const property = local.arguments[0].properties.find((candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === expression.name.text);
        if (property && ts.isPropertyAssignment(property)) return classifyExpression(property.initializer, index, hops, params);
      }
      const imported = index.imports.get(root.text);
      if (imported) {
        const exported = exportedInitializer(imported.file, imported.imported, hops - 1);
        if (exported) return classifyExpression(exported.expression, exported.index, hops - 1, new Set());
      }
    }
    return UNDECIDABLE;
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "freeze" && expression.arguments[0]) {
    return classifyExpression(expression.arguments[0], index, hops, params);
  }
  return UNDECIDABLE;
}

/** `export const NAME = …` in a file (or a re-export of it), followed at most `hops` hops. */
function exportedInitializer(file, name, hops) {
  if (!file || hops < 0) return null;
  const index = indexOf(file);
  const local = index.consts.get(name);
  if (local) return { expression: local, index };
  const reexport = index.reexports.get(name);
  if (reexport) return exportedInitializer(reexport.file, reexport.imported, hops - 1);
  return null;
}

function classifyExport(file, name, hops) {
  const found = exportedInitializer(file, name, hops);
  if (!found) return UNDECIDABLE;
  return classifyExpression(found.expression, found.index, hops, new Set());
}

/** The default value of a callee's parameter, resolved in the callee's own file. */
function classifyDefaultParameter(index, calleeName, argumentIndex, property) {
  const imported = index.imports.get(calleeName);
  const target = imported ? indexOf(imported.file) : index;
  const declaration = target.functions.get(imported ? imported.imported : calleeName);
  const parameter = declaration?.parameters?.[argumentIndex];
  if (!parameter?.initializer) return UNDECIDABLE;
  const init = parameter.initializer;
  if (property && ts.isObjectLiteralExpression(init)) return classifyExpression(init, target, 1, new Set());
  return classifyExpression(init, target, 1, new Set());
}

function enclosingParameters(node) {
  const names = new Set();
  let current = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
      for (const parameter of current.parameters) {
        if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
        else if (ts.isObjectBindingPattern(parameter.name)) for (const element of parameter.name.elements) if (ts.isIdentifier(element.name)) names.add(element.name.text);
      }
    }
    current = current.parent;
  }
  return names;
}

/** The nearest enclosing function body (or the file) of a node. */
function enclosingBody(node) {
  let current = node.parent;
  while (current && !ts.isFunctionDeclaration(current) && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current) && !ts.isMethodDeclaration(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

/** The parameter array a `set_config` string is executed with: the next array in its call, or the `params:` beside it. */
function contextParameters(literal) {
  const parent = literal.parent;
  if (ts.isCallExpression(parent)) {
    const position = parent.arguments.indexOf(literal);
    return parent.arguments.slice(position + 1).find((sibling) => ts.isArrayLiteralExpression(sibling));
  }
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    const params = parent.parent.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "params");
    return params && ts.isArrayLiteralExpression(params.initializer) ? params.initializer : undefined;
  }
  return undefined;
}

/**
 * The tenant context a session write runs under: the last
 * `set_config('tivdoc.tenant_id', …)` before it in the same function; failing
 * that (a probe row executed later by a runner), the one tenant every context
 * in the file sets. Two different tenants set in the file, and no context in
 * the function: undecidable.
 */
function tenantContextBefore(node, index) {
  const contexts = [];
  const visit = (candidate) => {
    if (ts.isStringLiteralLike(candidate) && candidate.text.includes(TENANT_CONTEXT_SQL)) {
      // `set_config('tivdoc.tenant_id', $1, …)` takes the tenant from the
      // parameters; `set_config('tivdoc.tenant_id', '', …)` spells it inline —
      // the empty tenant of a negative case is nobody's catalogue.
      const inline = /set_config\('tivdoc\.tenant_id',\s*'([^']*)'/u.exec(candidate.text);
      const array = contextParameters(candidate);
      contexts.push({
        pos: candidate.pos,
        body: enclosingBody(candidate),
        tenant: inline ? classifyText(inline[1])
          : array?.elements[0] ? classifyExpression(array.elements[0], index, 2, enclosingParameters(candidate)) : UNDECIDABLE,
      });
    }
    ts.forEachChild(candidate, visit);
  };
  visit(index.source);
  const body = enclosingBody(node);
  const before = contexts.filter((context) => context.body === body && context.pos < node.pos);
  if (before.length > 0) return before[before.length - 1].tenant;
  const tenants = new Set(contexts.map((context) => context.tenant));
  return tenants.size === 1 ? [...tenants][0] : UNDECIDABLE;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Every write site of one file, with the tenant each reaches. */
export function writeSitesOf(file) {
  const index = indexOf(file);
  const { source } = index;
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const params = enclosingParameters(node);
      // Helpers that take the tenant.
      if (ts.isIdentifier(callee) && Object.hasOwn(HELPERS, callee.text)) {
        const helper = HELPERS[callee.text];
        const argument = node.arguments[helper.index];
        let tenant;
        if (helper.kind === "argument") tenant = classifyExpression(argument, index, 2, params);
        else if (helper.kind === "argument_property") tenant = classifyExpression(argument, index, 2, params);
        else if (argument) tenant = classifyExpression(argument, index, 2, params);
        else tenant = classifyDefaultParameter(index, callee.text, helper.index, helper.property);
        sites.push({ kind: "helper", name: callee.text, tenant, line: lineOf(source, node) });
      }
    }
    // SQL. Wherever a string names a write function — `statement(name, sql, [params])`,
    // `client.query(sql, [params])`, or a probe row `[role, name, sql, [params]]` —
    // the parameter array that follows it in the same call or row carries the
    // tenant first. A write whose parameters cannot be found is undecidable.
    if (ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node.parent)) {
      const sql = node.text;
      const write = SQL_WRITE_FUNCTIONS.find((fn) => sql.includes(`${fn}(`));
      const session = SQL_SESSION_FUNCTIONS.find((fn) => sql.includes(`${fn}(`));
      if (write || session) {
        const siblings = ts.isCallExpression(node.parent) ? node.parent.arguments
          : ts.isArrayLiteralExpression(node.parent) ? node.parent.elements : [];
        const position = siblings.indexOf(node);
        const paramsArray = position >= 0 ? siblings.slice(position + 1).find((sibling) => ts.isArrayLiteralExpression(sibling)) : undefined;
        const params = enclosingParameters(node);
        let tenant = UNDECIDABLE;
        if (session) {
          tenant = tenantContextBefore(node, index);
        } else if (paramsArray && paramsArray.elements.length > 0) {
          tenant = classifyExpression(paramsArray.elements[0], index, 2, params);
        }
        sites.push({ kind: session ? "sql_session" : "sql", name: write ?? session, tenant, line: lineOf(source, node) });
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && REPOSITORY_CONSTRUCTOR.test(node.expression.text) && node.arguments && node.arguments.length >= 2) {
      const tenant = classifyExpression(node.arguments[1], index, 2, enclosingParameters(node));
      sites.push({ kind: "repository", name: node.expression.text, tenant, line: lineOf(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A helper whose write sites are bound to a parameter, and whose parameter
  // carries a default tenant, binds that tenant for every caller that omits it.
  if (sites.some((site) => site.tenant === "parameter")) {
    for (const [name, declaration] of index.functions) {
      for (const parameter of declaration.parameters ?? []) {
        if (!parameter.initializer) continue;
        const carriesTenant = (ts.isIdentifier(parameter.name) && parameter.name.text === "tenant")
          || (ts.isObjectLiteralExpression(parameter.initializer) && parameter.initializer.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "tenant"));
        if (!carriesTenant) continue;
        sites.push({ kind: "default_parameter", name, tenant: classifyExpression(parameter.initializer, index, 2, new Set()), line: lineOf(source, parameter) });
      }
    }
  }
  return sites;
}

function classificationOf(sites) {
  const tenants = new Set(sites.map((site) => site.tenant));
  if (tenants.has(REFERENCE)) return REFERENCE;
  if (tenants.has(UNDECIDABLE)) return UNDECIDABLE;
  const concrete = [...tenants].filter((tenant) => tenant !== "parameter");
  if (concrete.length === 0) return tenants.has("parameter") ? PARAMETERISED : null;
  if (concrete.length === 1) return concrete[0];
  // Synthetic-proof rows beside own-per-run rows: both are proof rows, neither the catalogue.
  return SYNTHETIC;
}

/** The inventory of a directory: every .mts file that writes, and where. */
export function deriveWriterInventory(directory) {
  indexCache.clear();
  const files = readdirSync(directory).filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts")).sort();
  const inventory = {};
  for (const name of files) {
    const sites = writeSitesOf(path.join(directory, name));
    const classification = classificationOf(sites);
    if (classification === null) continue;
    inventory[name] = { classification, sites };
  }
  return inventory;
}

/** What the suite asserts: every reference writer has a reason; nothing is undecidable; a helper is reached by a classified writer. */
export function inventoryFindings(directory, reasons) {
  const inventory = deriveWriterInventory(directory);
  const findings = [];
  for (const [name, entry] of Object.entries(inventory)) {
    const reason = reasons[name];
    if (entry.classification === UNDECIDABLE) findings.push(`${name}: undecidable — ${entry.sites.filter((site) => site.tenant === UNDECIDABLE).map((site) => `${site.kind}:${site.name}@${site.line}`).join(", ")}`);
    if (entry.classification === REFERENCE && !(typeof reason === "string" && reason.length > 40 && reason.endsWith("."))) findings.push(`${name}: reference writer without a reason — ${entry.sites.filter((site) => site.tenant === REFERENCE).map((site) => `${site.kind}:${site.name}@${site.line}`).join(", ")}`);
    if (entry.classification !== REFERENCE && typeof reason === "string" && reason !== "") findings.push(`${name}: carries a reason but does not write to the reference tenant (${entry.classification})`);
    if (entry.classification === PARAMETERISED) {
      const callers = Object.keys(inventory).filter((other) => other !== name && readFileSync(path.join(directory, other), "utf8").includes(`./${name}`));
      if (callers.length === 0) findings.push(`${name}: parameterised helper reached by no classified writer`);
    }
  }
  for (const name of Object.keys(reasons)) if (!inventory[name]) findings.push(`${name}: listed with a reason but is not a writer`);
  return { inventory, findings };
}
