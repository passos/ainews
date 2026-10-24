// Helpers shared by the trial scripts (scripts/try-analysis.ts,
// scripts/probe-write.ts): the real fixtures, the env file and the AI binding.
// Never run in CI or `npm test`.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { isEnabled } from "../src/lib/flags.ts";
import {
  bindingTransport,
  TransportHttpError,
} from "../src/providers/transport.ts";
import type { ModelTransport } from "../src/providers/transport.ts";
import { SEED_INDUSTRIES } from "../src/server/db/seed/industries.ts";
import { realFixture } from "../tests/fixtures/analysis/real-shape.ts";
import type { RealFixture } from "../tests/fixtures/analysis/real-shape.ts";

const CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.jsonc", import.meta.url),
);
const FIXTURES = fileURLToPath(
  new URL("../tests/fixtures/analysis/real/", import.meta.url),
);

/** Value of `--env-file`, default .env.prod. Exits 2 without a path. */
export function envFileArg(args: string[]): string {
  const at = args.indexOf("--env-file");
  const file = at >= 0 ? args[at + 1] : ".env.prod";
  if (at >= 0 && !file) {
    console.error("--env-file needs a path.");
    process.exit(2);
  }
  return file;
}

export function loadFixtures(): { file: string; fixture: RealFixture }[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: realFixture.parse(
        JSON.parse(readFileSync(FIXTURES + file, "utf8")),
      ),
    }));
}

/** The seeded industry of a fixture. */
export function industryOf(fixture: RealFixture) {
  const industry = SEED_INDUSTRIES.find((i) => i.slug === fixture.industry);
  if (!industry) throw new Error(`unknown industry ${fixture.industry}`);
  return industry;
}

export function describe(error: unknown): string {
  if (error instanceof TransportHttpError) {
    return `HTTP ${error.status}: ${error.body.slice(0, 500)}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * Loads the env file (variables that are already set win), needs
 * MODEL_CALLS_ENABLED=true, AI_GATEWAY_ID and CLOUDFLARE_API_TOKEN, then runs
 * `run` with the AI binding transport. Tokens are never printed.
 */
export async function withBindingTransport(
  envFile: string,
  run: (transport: ModelTransport) => Promise<number>,
): Promise<number> {
  process.loadEnvFile(envFile);
  if (!isEnabled(process.env, "MODEL_CALLS_ENABLED")) {
    console.error("MODEL_CALLS_ENABLED must be true in the environment.");
    return 2;
  }
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      console.error(`Missing environment variable ${name}.`);
      process.exit(2);
    }
    return value;
  };
  need("CLOUDFLARE_API_TOKEN");
  // The REST route returned 400 "No route for that URI" for typesafe/jev and
  // google/gemini-3.8-flash (cause not investigated, see #39; maybe the route
  // shape of gateway models). The trials use the AI binding as production
  // does (the same wiring as the binding path of scripts/smoke-models.ts).
  const proxy = await getPlatformProxy<{ AI: Ai }>({
    configPath: CONFIG_PATH,
    persist: false,
  });
  try {
    return await run(bindingTransport(proxy.env.AI, need("AI_GATEWAY_ID")));
  } finally {
    await proxy.dispose();
  }
}
