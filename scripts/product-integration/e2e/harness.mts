import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const REPOSITORY_ROOT = process.cwd();
export const CASE_ID = "fb376586-bf37-4cec-8663-9a4065b10b7d";
export const SESSION_COOKIE = "tivdoc_hermetic_session";
const PAYMENT_CORE = Object.freeze({
  evidence_id: "browser-payment-01",
  evidence_revision: "browser-payment-revision-01",
  case_reference: CASE_ID,
  customer_reference: "owner-a-01",
  amount: { currency: "XTS", minor_units: 1 },
  status: "settled" as const,
  duplicate_of_evidence_id: null,
});
const CHARGEBACK_CORE = Object.freeze({ ...PAYMENT_CORE, evidence_revision: "browser-payment-revision-02", status: "chargeback" as const });
export const CHARGEBACK_EVIDENCE_SHA256 = sha(canonicalValue(CHARGEBACK_CORE));
export const SYNTHETIC_TICKETS = Object.freeze({
  ownerA: "portal-owner-a-ticket-0001",
  ownerB: "portal-owner-b-ticket-0001",
  legal: "operations-legal-ticket-0001",
  approver: "operations-approver-ticket-0001",
  intake: "operations-intake-ticket-0001",
  auditor: "operations-auditor-ticket-0001",
});

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PWCLI = "C:\\Users\\smart\\.codex\\skills\\playwright\\scripts\\playwright_cli.sh";
const NEXT_BIN = path.join(REPOSITORY_ROOT, "node_modules", "next", "dist", "bin", "next");
const SESSION_SECRET = "v08-hermetic-session-secret-000000000000000000000001";

export type HttpRecord = Readonly<{
  step: string;
  method: string;
  path: string;
  status: number;
  response_sha256: string;
}>;

export type IssuedSession = Readonly<{
  cookie: string;
  csrf: string;
  expires_at_epoch: number;
  set_cookie_attributes: readonly string[];
}>;

export type ServerHandle = Readonly<{
  baseUrl: string;
  port: number;
  process: ChildProcessWithoutNullStreams;
  logPath: string;
}>;

export function outputRoot(lane: "synthetic" | "negative"): string {
  const root = path.join(REPOSITORY_ROOT, "output", "product-integration-v0.8.0", "e2e", lane);
  mkdirSync(root, { recursive: true });
  return root;
}

export function playwrightRoot(lane: string): string {
  const root = path.join(REPOSITORY_ROOT, "output", "playwright", `v08-${lane}`);
  mkdirSync(root, { recursive: true });
  return root;
}

export async function startServer(input: Readonly<{
  lane: "synthetic" | "negative";
  label: string;
  runtimeEnabled: boolean;
  stableRoutesEnabled: boolean;
  vercelEnv?: "preview" | "production";
  maxSessionSeconds?: number;
}>): Promise<ServerHandle> {
  const port = await freePort();
  const logPath = path.join(outputRoot(input.lane), `server-${input.label}.log`);
  const stream = createWriteStream(logPath, { flags: "w" });
  const flags = input.stableRoutesEnabled ? "true" : "false";
  const child = spawn(process.execPath, [NEXT_BIN, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPOSITORY_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      TIVDOC_HERMETIC_MODE: "true",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: input.runtimeEnabled ? "true" : "false",
      TIVDOC_PRODUCT_E2E_LANE: input.lane,
      TIVDOC_PRODUCT_SESSION_SECRET: SESSION_SECRET,
      TIVDOC_PRODUCT_SESSION_MAX_AGE_SECONDS: String(input.maxSessionSeconds ?? 900),
      TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify(ticketRecords()),
      TIVDOC_PORTAL_UI_ENABLED: flags,
      TIVDOC_PORTAL_API_ENABLED: flags,
      TIVDOC_OPERATIONS_UI_ENABLED: flags,
      TIVDOC_OPERATIONS_API_ENABLED: flags,
      VERCEL_ENV: input.vercelEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const handle = Object.freeze({ baseUrl: `http://127.0.0.1:${port}`, port, process: child, logPath });
  try {
    await waitForReady(handle);
    return handle;
  } catch (error) {
    await stopServer(handle);
    throw error;
  }
}

export async function stopServer(server: ServerHandle): Promise<void> {
  if (server.process.exitCode !== null) return;
  if (process.platform === "win32" && server.process.pid) {
    spawnSync("taskkill", ["/PID", String(server.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    server.process.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => server.process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

export async function issueSession(
  server: ServerHandle,
  audience: "portal" | "operations",
  ticket: string,
  matrix: HttpRecord[],
  step: string,
): Promise<IssuedSession> {
  const response = await recordedFetch(server, matrix, step, `/api/${audience}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert(response.status === 201, `${step}:SESSION_ISSUE_FAILED:${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.match(new RegExp(`^${SESSION_COOKIE}=([^;]+)`))?.[1] ?? "";
  const body = await response.clone().json() as { csrf_token?: unknown; expires_at_epoch?: unknown };
  assert(cookie.length > 40, `${step}:SESSION_COOKIE_MISSING`);
  assert(typeof body.csrf_token === "string" && body.csrf_token.length >= 32, `${step}:CSRF_MISSING`);
  assert(Number.isSafeInteger(body.expires_at_epoch), `${step}:EXPIRY_MISSING`);
  const attributes = setCookie.split(";").slice(1).map((item) => item.trim());
  assert(attributes.includes("HttpOnly") && attributes.includes("SameSite=Strict"), `${step}:COOKIE_SECURITY_ATTRIBUTES_MISSING`);
  return Object.freeze({ cookie, csrf: body.csrf_token, expires_at_epoch: body.expires_at_epoch as number, set_cookie_attributes: attributes });
}

export async function recordedFetch(
  server: ServerHandle,
  matrix: HttpRecord[],
  step: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(pathname, server.baseUrl);
  assert(isLoopback(url.hostname), "NON_LOOPBACK_HTTP_FORBIDDEN");
  let response: Response | null = null;
  // Canonical mutations carry idempotency keys; session and access-grant
  // issuance are bounded to this local test process. Retrying a transient Next
  // dev socket reset therefore cannot duplicate a production-side effect.
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(url, { ...init, redirect: "manual" });
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(response, `LOOPBACK_HTTP_NO_RESPONSE:${step}`);
  const clone = response.clone();
  const bytes = new Uint8Array(await clone.arrayBuffer());
  matrix.push(Object.freeze({
    step,
    method: init.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    status: response.status,
    response_sha256: sha(bytes),
  }));
  return response;
}

export function authHeaders(session: IssuedSession, server: ServerHandle, csrf = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.cookie}`,
    ...(csrf ? { "x-tivdoc-csrf": session.csrf, origin: server.baseUrl, "sec-fetch-site": "same-origin" } : {}),
  };
}

export function jsonHeaders(session: IssuedSession, server: ServerHandle, csrf = true): Record<string, string> {
  return { ...authHeaders(session, server, csrf), "content-type": "application/json" };
}

export function operationsCommand(input: Readonly<{
  action: string;
  expectedRevision: number;
  payload: Readonly<Record<string, unknown>>;
  idempotency: string;
  command?: string;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: "tivdoc-operations-command",
    command_id: input.command ?? `browser-command-${input.idempotency}`,
    idempotency_key: input.idempotency,
    expected_revision: input.expectedRevision,
    reason: "בדיקת אינטגרציה סינתטית מתועדת",
    payload: Object.freeze({ action: input.action, case_id: CASE_ID, ...input.payload }),
  });
}

export function runPlaywright(session: string, cwd: string, command: string, args: readonly string[] = []): unknown {
  const result = spawnSync(BASH, [PWCLI, `-s=${session}`, command, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`PLAYWRIGHT_CLI_FAILED:${command}:${result.status ?? "spawn"}:${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  const stdout = result.stdout.trim();
  const parsed = stdout.length > 0 ? JSON.parse(stdout) : null;
  if (containsPlaywrightError(parsed)) throw new Error(`PLAYWRIGHT_CLI_RESULT_ERROR:${command}:${stdout}`);
  return parsed;
}

export function snapshot(session: string, cwd: string): unknown {
  const result = runPlaywright(session, cwd, "snapshot");
  const file = nestedString(result, "file");
  if (file?.endsWith(".yml")) return readFileSync(path.resolve(cwd, file), "utf8");
  return result;
}

export function snapshotText(value: unknown): string {
  return JSON.stringify(value);
}

export function findRef(value: unknown, predicate: (node: Readonly<Record<string, unknown>>) => boolean): string {
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/u)) {
      const match = line.match(/^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?.*\[ref=(e\d+)\]/u);
      if (!match) continue;
      const node = Object.freeze({ role: match[1], name: match[2] ?? "", ref: match[3] });
      if (predicate(node)) return match[3];
    }
  }
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    if (typeof record.ref === "string" && predicate(record)) return record.ref;
    queue.push(...Object.values(record));
  }
  throw new Error("PLAYWRIGHT_SNAPSHOT_REF_NOT_FOUND");
}

export function clickByName(session: string, cwd: string, namePart: string): void {
  const view = snapshot(session, cwd);
  const ref = findRef(view, (node) => typeof node.name === "string" && node.name.includes(namePart));
  runPlaywright(session, cwd, "click", [ref]);
}

export function fillFirstTextbox(session: string, cwd: string, value: string): void {
  const view = snapshot(session, cwd);
  const ref = findRef(view, (node) => node.role === "textbox");
  runPlaywright(session, cwd, "fill", [ref, value]);
}

export function waitBrowser(session: string, cwd: string, milliseconds = 750): void {
  runPlaywright(session, cwd, "run-code", [`async (page) => { await page.waitForTimeout(${milliseconds}); return true; }`]);
}

export function setBrowserSession(session: string, cwd: string, issued: IssuedSession, baseUrl: string): void {
  const cookie = [{ name: SESSION_COOKIE, value: issued.cookie, url: baseUrl, httpOnly: true, secure: false, sameSite: "Strict" }];
  runPlaywright(session, cwd, "run-code", [`async (page) => { await page.context().addCookies(${JSON.stringify(cookie)}); return true; }`]);
}

export function captureScreenshot(session: string, cwd: string, filename: string): string {
  runPlaywright(session, cwd, "screenshot", ["--filename", filename, "--full-page"]);
  const screenshot = path.join(cwd, filename);
  assert(existsSync(screenshot), `SCREENSHOT_MISSING:${filename}`);
  return screenshot;
}

export function copyScreenshot(source: string, laneOutput: string): Readonly<{ path: string; sha256: string; byte_count: number }> {
  const targetRoot = path.join(laneOutput, "screenshots");
  mkdirSync(targetRoot, { recursive: true });
  const target = path.join(targetRoot, path.basename(source));
  copyFileSync(source, target);
  const bytes = readFileSync(target);
  return Object.freeze({ path: relative(target), sha256: sha(bytes), byte_count: bytes.byteLength });
}

export function writeReceipt(root: string, name: string, value: unknown): Readonly<{ path: string; sha256: string }> {
  const target = path.join(root, name);
  const body = canonicalJson(value);
  writeFileSync(target, body, "utf8");
  return Object.freeze({ path: relative(target), sha256: sha(body) });
}

export function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

export function relative(target: string): string {
  return path.relative(REPOSITORY_ROOT, target).replaceAll("\\", "/");
}

function ticketRecords(): Readonly<Record<string, unknown>> {
  const actors = Object.freeze({
    ownerA: actor("owner-a-01", "customer_owner"),
    ownerB: actor("owner-b-01", "customer_owner"),
    legal: actor("legal-reviewer-01", "legal_reviewer"),
    approver: actor("report-approver-01", "report_approver"),
    intake: actor("intake-operator-01", "intake_operator"),
    auditor: actor("auditor-01", "auditor"),
  });
  return Object.freeze({
    [SYNTHETIC_TICKETS.ownerA]: { audience: "portal", actor: actors.ownerA },
    [SYNTHETIC_TICKETS.ownerB]: { audience: "portal", actor: actors.ownerB },
    [SYNTHETIC_TICKETS.legal]: { audience: "operations", actor: actors.legal },
    [SYNTHETIC_TICKETS.approver]: { audience: "operations", actor: actors.approver },
    [SYNTHETIC_TICKETS.intake]: { audience: "operations", actor: actors.intake },
    [SYNTHETIC_TICKETS.auditor]: { audience: "operations", actor: actors.auditor },
  });
}

function actor(actorId: string, role: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    actor_id: actorId,
    role,
    tenant_id: "tenant01",
    assigned_case_ids: Object.freeze([CASE_ID]),
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

async function waitForReady(server: ServerHandle): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.process.exitCode !== null) break;
    try {
      const response = await fetch(`${server.baseUrl}/api/portal/session`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // Server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const log = existsSync(server.logPath) ? readFileSync(server.logPath, "utf8").slice(-8_000) : "";
  throw new Error(`NEXT_SERVER_NOT_READY:${server.process.exitCode ?? "timeout"}:${log}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("EPHEMERAL_PORT_ALLOCATION_FAILED"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, item]) => [key, sortValue(item)]));
}

function nestedString(value: unknown, key: string): string | null {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) { queue.push(...current); continue; }
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    if (typeof record[key] === "string") return record[key];
    queue.push(...Object.values(record));
  }
  return null;
}

function containsPlaywrightError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPlaywrightError);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.isError === true || Object.values(record).some(containsPlaywrightError);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("CANONICAL_VALUE_UNSUPPORTED");
}
