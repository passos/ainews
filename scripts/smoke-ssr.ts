// SSR smoke test against the production build, served by `vite preview`.
// Usage: npm run build && npm run test:ssr
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// A server function id from the server build. The TanStack compiler writes
// `createServerRpc({ id, name, filename }, ...)` for each server function.
function serverFnId(fnName: string, filename: string): string {
  const dir = "dist/server/assets";
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(`${dir}/${name}`, "utf8");
    const pattern =
      /\bid:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*filename:\s*"([^"]+)"/g;
    for (const m of source.matchAll(pattern)) {
      if (m[2] === fnName && m[3] === filename) ids.add(m[1]);
    }
  }
  if (ids.size !== 1) {
    console.error(
      `FAIL: expected 1 server function id for ${fnName}, found ${ids.size}`,
    );
    process.exit(1);
  }
  return [...ids][0];
}

const ADMIN_FN_ID = serverFnId(
  "getAdminIdentity",
  "src/server/admin/identity.ts",
);
const PUBLIC_FN_ID = serverFnId(
  "getSiteInfo",
  "src/server/publication/site.ts",
);
const ADMIN_EMAIL: string = JSON.parse(
  readFileSync("dist/server/wrangler.json", "utf8"),
).vars.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  console.error("FAIL: no ADMIN_EMAIL in dist/server/wrangler.json");
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

  // An anonymous call to an admin server function goes through the real
  // TanStack dispatch and accessMiddleware: 403, and no admin data. It sends
  // the headers a same-origin browser call sends, so TanStack's default CSRF
  // middleware lets it through and the 403 comes from accessMiddleware.
  // The public function, called the same way, must return 200: this shows
  // the 403 is specific to the admin function.
  const callFn = (id: string) =>
    fetch(`${BASE}/_serverFn/${id}`, {
      headers: { "x-tsr-serverfn": "true", "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  const publicFn = await callFn(PUBLIC_FN_ID);
  await publicFn.text();
  if (publicFn.status !== 200) {
    fail(`server function getSiteInfo returned ${publicFn.status}`);
  }
  const adminFn = await callFn(ADMIN_FN_ID);
  const adminBody = await adminFn.text();
  if (adminFn.status !== 403) {
    fail(`server function getAdminIdentity returned ${adminFn.status}`);
  }
  if (adminBody.includes(ADMIN_EMAIL)) {
    fail("server function getAdminIdentity leaks ADMIN_EMAIL");
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
