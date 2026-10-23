// SSR smoke test against the production build, served by `vite preview`.
// Usage: npm run build && npm run test:ssr
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 60_000;

// Ask the OS for a free port. Another job on the same machine may hold 4173.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

if (!existsSync("dist")) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(
  "npx",
  [
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  { stdio: ["ignore", "inherit", "inherit"], detached: true },
);

function stop() {
  if (server.pid !== undefined && server.exitCode === null) {
    try {
      // Kill the whole process group: npx -> vite -> workerd.
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  clearTimeout(deadlineTimer);
  stop();
  process.exit(1);
}

// Hard limit for the whole script, so a hung request cannot block CI.
const deadlineTimer = setTimeout(() => {
  fail(`smoke test did not finish within ${TOTAL_TIMEOUT_MS / 1000}s`);
}, TOTAL_TIMEOUT_MS);

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      fail(`vite preview exited early with code ${server.exitCode}`);
    }
    try {
      await fetch(`${BASE}/`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`server did not start within ${TIMEOUT_MS / 1000}s`);
}

async function main() {
  await waitForServer();

  const home = await fetch(`${BASE}/`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await home.text();
  if (home.status !== 200) fail(`GET / returned ${home.status}`);
  const type = home.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) fail(`GET / content-type is "${type}"`);
  if (!/<!doctype html/i.test(body)) fail("GET / has no <!doctype html>");
  if (!body.includes("Personal News")) fail('GET / has no "Personal News"');
  const csp = home.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'self'")) {
    fail(`GET / content-security-policy is "${csp}"`);
  }

  // The test env has empty Access vars, so every admin variant fails closed.
  // "//admin" is not sent: vite preview parses it as a protocol-relative URL,
  // so the worker sees http://admin/. "/%2Fadmin" reaches the worker and
  // decodes to "//admin". tests/edge.test.ts covers "//admin" directly.
  for (const path of ["/admin", "/Admin", "/%2Fadmin", "/%61dmin"]) {
    const res = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await res.text();
    if (res.status !== 403) fail(`GET ${path} returned ${res.status}`);
  }

  const bogus = await fetch(`${BASE}/?audience=bogus`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await bogus.text();
  if (bogus.status !== 200) {
    fail(`GET /?audience=bogus returned ${bogus.status}`);
  }

  console.log("PASS: SSR smoke test");
  clearTimeout(deadlineTimer);
  stop();
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
