// SSR smoke test against the production build, served by `vite preview`.
// Usage: npm run build && npm run test:ssr
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const TIMEOUT_MS = 30_000;

if (!existsSync("dist")) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

const server = spawn(
  "npx",
  ["vite", "preview", "--port", String(PORT), "--strictPort"],
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
  stop();
  process.exit(1);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      fail(`vite preview exited early with code ${server.exitCode}`);
    }
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`server did not start within ${TIMEOUT_MS / 1000}s`);
}

async function main() {
  await waitForServer();

  const home = await fetch(`${BASE}/`);
  const body = await home.text();
  if (home.status !== 200) fail(`GET / returned ${home.status}`);
  const type = home.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) fail(`GET / content-type is "${type}"`);
  if (!/<!doctype html/i.test(body)) fail("GET / has no <!doctype html>");
  if (!body.includes("Personal News")) fail('GET / has no "Personal News"');

  const bogus = await fetch(`${BASE}/?audience=bogus`);
  await bogus.text();
  if (bogus.status !== 200) {
    fail(`GET /?audience=bogus returned ${bogus.status}`);
  }

  console.log("PASS: SSR smoke test");
  stop();
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
