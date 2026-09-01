import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { TLSSocket } from "node:tls";

import next from "next";

const ROOT = resolve(process.cwd());
const PORT = exactPort(process.env.TIVDOC_DURABLE_BROWSER_HTTPS_PORT);
const CERTIFICATE_PATH = exactLocalPath(process.env.TIVDOC_DURABLE_BROWSER_CERTIFICATE_PATH);
const PRIVATE_KEY_PATH = exactLocalPath(process.env.TIVDOC_DURABLE_BROWSER_PRIVATE_KEY_PATH);

const [certificate, privateKey] = await Promise.all([
  readFile(CERTIFICATE_PATH),
  readFile(PRIVATE_KEY_PATH),
]);
const server = createServer({ cert: certificate, key: privateKey });
const app = next({
  dev: false,
  dir: ROOT,
  hostname: "127.0.0.1",
  port: PORT,
  httpServer: server,
});
let closing = false;

try {
  await app.prepare();
  const handler = app.getRequestHandler();
  server.on("request", (request, response) => {
    if (!(request.socket instanceof TLSSocket) || !request.socket.encrypted) {
      response.writeHead(400);
      response.end();
      return;
    }
    // Next's custom-server adapter reconstructs this loopback Request with a
    // `localhost` hostname even though the raw TLS request is bound to
    // 127.0.0.1. Pin the forwarded transport/host before the fail-closed
    // verification-only origin adapter runs.
    request.headers["x-forwarded-proto"] = "https";
    request.headers["x-forwarded-host"] = request.headers.host;
    const expectedHost = `127.0.0.1:${PORT}`;
    if (request.headers.host !== expectedHost || !request.url?.startsWith("/")) {
      response.writeHead(421);
      response.end();
      return;
    }
    installStrictNextRequestOriginAdapter();
    installSafeOperationsFailureObserver();
    void handler(request, response)
      .then(() => {
        installStrictNextRequestOriginAdapter();
        installSafeOperationsFailureObserver();
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(PORT, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: "tivdoc-durable-browser-https-server-v0.10.2",
    status: "READY",
    host: "127.0.0.1",
    port: PORT,
    transport: "https_ephemeral_self_signed",
  })}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk === "shutdown\n") void shutdown(0);
  });
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
} catch {
  await shutdown(70);
}

async function shutdown(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
  await app.close().catch(() => undefined);
  process.exitCode = exitCode;
}

function exactPort(value: string | undefined): number {
  if (!value || !/^4[0-9]{4}$/u.test(value)) throw new Error("DURABLE_BROWSER_HTTPS_PORT_INVALID");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 40_000 || port > 49_151) {
    throw new Error("DURABLE_BROWSER_HTTPS_PORT_INVALID");
  }
  return port;
}

function exactLocalPath(value: string | undefined): string {
  if (!value || !isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)
      || (process.platform === "win32" && /^\\\\/u.test(value))) {
    throw new Error("DURABLE_BROWSER_HTTPS_CERTIFICATE_PATH_INVALID");
  }
  return resolve(value);
}

function installStrictNextRequestOriginAdapter(): boolean {
  type SessionBoundary = Readonly<{
    __strict_next_request_origin_adapter?: true;
    proof_class: string;
    request_origin?: string;
    verify(request: Request, audience: "operations" | "portal", requireCsrf: boolean): Promise<unknown> | unknown;
  }>;
  const runtime = globalThis as typeof globalThis & {
    __tivdocProductSessionBoundary?: SessionBoundary;
  };
  const boundary = runtime.__tivdocProductSessionBoundary;
  if (!boundary || Reflect.get(boundary, "__strict_next_request_origin_adapter") === true) {
    return Boolean(boundary);
  }
  const expectedOrigin = boundary.request_origin;
  if (typeof expectedOrigin !== "string" || expectedOrigin !== `https://127.0.0.1:${PORT}`) {
    throw new Error("DURABLE_BROWSER_SESSION_ORIGIN_INVALID");
  }
  const verify = boundary.verify.bind(boundary);
  runtime.__tivdocProductSessionBoundary = Object.freeze({
    __strict_next_request_origin_adapter: true,
    proof_class: boundary.proof_class,
    request_origin: expectedOrigin,
    async verify(request: Request, audience: "operations" | "portal", requireCsrf: boolean) {
      const url = new URL(request.url);
      if (url.origin === expectedOrigin) return await verify(request, audience, requireCsrf);
      if (url.origin !== `https://localhost:${PORT}`
          || request.headers.get("host") !== `127.0.0.1:${PORT}`
          || request.headers.get("x-forwarded-host") !== `127.0.0.1:${PORT}`
          || request.headers.get("x-forwarded-proto") !== "https") return null;
      const canonical = new Request(`${expectedOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
      });
      return await verify(canonical, audience, requireCsrf);
    },
  });
  return true;
}

function installSafeOperationsFailureObserver(): boolean {
  type OperationsService = Readonly<{
    __safe_failure_observer?: true;
    read(...args: unknown[]): unknown;
    mutate(...args: unknown[]): unknown;
  }>;
  type Services = Readonly<{ portal: unknown; operations?: OperationsService }>;
  const runtime = globalThis as typeof globalThis & {
    __tivdocCanonicalProductRouteServices?: Services;
  };
  const services = runtime.__tivdocCanonicalProductRouteServices;
  const operations = services?.operations;
  if (!services || !operations || operations.__safe_failure_observer === true) {
    return Boolean(operations);
  }
  runtime.__tivdocCanonicalProductRouteServices = Object.freeze({
    portal: services.portal,
    operations: Object.freeze({
      __safe_failure_observer: true,
      read: (...args: unknown[]) => Reflect.apply(operations.read, operations, args),
      async mutate(...args: unknown[]) {
        try {
          return await Reflect.apply(operations.mutate, operations, args);
        } catch (error) {
          process.stdout.write(`TIVDOC_SAFE_RUNTIME_FAILURE:${safeRuntimeFailureCode(error)}\n`);
          throw error;
        }
      },
    }),
  });
  return true;
}

function safeRuntimeFailureCode(error: unknown): string {
  const candidates = [
    error && typeof error === "object" && "code" in error ? error.code : null,
    error instanceof Error ? error.message : null,
  ];
  return candidates.find((value): value is string =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{2,120}$/u.test(value))
    ?? "RUNTIME_FAILURE_REDACTED";
}
