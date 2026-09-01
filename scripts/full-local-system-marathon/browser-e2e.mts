import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MARATHON_BROWSER_BASE_URL,
  MARATHON_BROWSER_ROUTES,
  MARATHON_BROWSER_SERVER_ARGS,
  MARATHON_BROWSER_SESSION_COOKIE,
  extractMarathonBrowserSessionCookie,
  isHermeticBrowserDocumentResponse,
  marathonBrowserServerEnvironment,
  marathonBrowserToolEnvironment,
} from "./browser-e2e-runtime.mts";

const ROOT = path.resolve(process.cwd());
const OUTPUT = path.join(ROOT, "output", "playwright", "v010-marathon");
const BASE_URL = MARATHON_BROWSER_BASE_URL;
const SESSION = "tivdoc-v010-marathon";
const STARTUP_SMOKE = process.argv.includes("--startup-smoke");
const CLI = path.join(ROOT, "node_modules", "@playwright", "cli", "playwright-cli.js");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const serverOutput: string[] = [];
let server: ChildProcessWithoutNullStreams | null = null;

await mkdir(OUTPUT, { recursive: true });
const commands: Readonly<Record<string, unknown>>[] = [];
try {
  server = spawn(process.execPath, [NEXT, ...MARATHON_BROWSER_SERVER_ARGS], {
    cwd: ROOT,
    env: marathonBrowserServerEnvironment(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
  await waitForServer();

  commands.push(runCli("open", ["open", BASE_URL, "--browser", "msedge"]));
  commands.push(runCli("resize_desktop", ["resize", "1440", "900"]));
  const sessions = Object.freeze({
    portal: await issueSession("portal", MARATHON_BROWSER_ROUTES[1].ticket),
    operations: await issueSession("operations", MARATHON_BROWSER_ROUTES[2].ticket),
  });
  for (const page of MARATHON_BROWSER_ROUTES) {
    const session = page.audience ? sessions[page.audience] : null;
    if (session) commands.push(installBrowserSession(`session_${page.id}`, session));
    commands.push(runCli(`goto_${page.id}`, ["goto", `${BASE_URL}${page.path}`]));
    if (!STARTUP_SMOKE) {
      commands.push(runCli(`snapshot_${page.id}`, ["snapshot", "--filename", path.join(OUTPUT, `${page.id}-desktop.md`)]));
      commands.push(runCli(`screenshot_${page.id}`, ["screenshot", "--filename", path.join(OUTPUT, `${page.id}-desktop.png`), "--full-page"]));
    }
    const response = await fetch(`${BASE_URL}${page.path}`, {
      redirect: "manual",
      headers: session ? { cookie: `${MARATHON_BROWSER_SESSION_COOKIE}=${session}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) throw new Error(`BROWSER_E2E_HTTP_STATUS:${page.id}:${response.status}`);
    if (!isHermeticBrowserDocumentResponse(response.headers)) {
      throw new Error(`BROWSER_E2E_SECURITY_HEADERS:${page.id}`);
    }
  }
  if (!STARTUP_SMOKE) {
    commands.push(runCli("resize_mobile", ["resize", "390", "844"]));
    commands.push(installBrowserSession("session_portal_mobile", sessions.portal));
    commands.push(runCli("goto_portal_mobile", ["goto", `${BASE_URL}/portal`]));
    commands.push(runCli("snapshot_portal_mobile", ["snapshot", "--filename", path.join(OUTPUT, "portal-mobile.md")]));
    commands.push(runCli("screenshot_portal_mobile", ["screenshot", "--filename", path.join(OUTPUT, "portal-mobile.png"), "--full-page"]));
    commands.push(runCli("console_errors", ["console", "error"]));
  }

  const snapshots = await Promise.all((STARTUP_SMOKE ? [] : ["home-desktop.md", "portal-desktop.md", "operations-desktop.md", "portal-mobile.md"]).map(async (name) => {
    const bytes = await readFile(path.join(OUTPUT, name));
    if (bytes.byteLength < 32) throw new Error(`BROWSER_E2E_SNAPSHOT_EMPTY:${name}`);
    return Object.freeze({ path: `output/playwright/v010-marathon/${name}`, byte_count: bytes.byteLength, sha256: hash(bytes) });
  }));
  const receipt = Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-browser-e2e-v0.10.0",
    status: "PASS",
    run_class: STARTUP_SMOKE ? "FOCUSED_STARTUP_LOGIN_NAVIGATION" : "FULL_RENDERED_BROWSER_MATRIX",
    browser: "msedge",
    origin: BASE_URL,
    rendered_routes: ["/", "/portal", "/operations"],
    viewports: ["1440x900", "390x844"],
    real_browser_cli: true,
    direct_service_shortcuts: false,
    snapshots,
    command_count: commands.length,
    command_receipts: commands,
    server_output_sha256: hash(serverOutput.join("")),
  });
  await writeFile(path.join(OUTPUT, STARTUP_SMOKE ? "browser-startup-smoke-receipt.json" : "browser-e2e-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  runCliAllowFailure("close", ["close"]);
  if (server?.exitCode === null) {
    if (process.platform === "win32" && server.pid) {
      spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  }
}

function runCli(commandId: string, args: readonly string[]): Readonly<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [CLI, `-s=${SESSION}`, ...args], {
    cwd: ROOT,
    env: safeEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`BROWSER_E2E_CLI_FAILED:${commandId}:${result.stderr.trim()}`);
  }
  return Object.freeze({
    command_id: commandId,
    exit_code: result.status,
    stdout_sha256: hash(result.stdout),
    stderr_sha256: hash(result.stderr),
  });
}

function runCliAllowFailure(commandId: string, args: readonly string[]): void {
  try {
    runCli(commandId, args);
  } catch {
    // Cleanup is best-effort; the primary receipt has already retained failure.
  }
}

async function issueSession(audience: "portal" | "operations", ticket: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/${audience}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201) throw new Error(`BROWSER_E2E_SESSION_ISSUE_FAILED:${audience}:${response.status}`);
  return extractMarathonBrowserSessionCookie(response.headers.get("set-cookie"));
}

function installBrowserSession(commandId: string, value: string): Readonly<Record<string, unknown>> {
  const cookie = [{
    name: MARATHON_BROWSER_SESSION_COOKIE,
    value,
    url: BASE_URL,
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
  }];
  return runCli(commandId, ["run-code", [`async (page) => { await page.context().addCookies(${JSON.stringify(cookie)}); return true; }`]]);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`BROWSER_E2E_SERVER_EXITED:${server?.exitCode}`);
    try {
      const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(1_000) });
      if (response.status > 0) return;
    } catch {
      // The bounded loop continues while the local server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const diagnostic = serverOutput.join("").slice(-8_000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "");
  throw new Error(`BROWSER_E2E_SERVER_START_TIMEOUT:${diagnostic}`);
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return marathonBrowserToolEnvironment();
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
