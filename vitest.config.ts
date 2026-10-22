import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./drizzle/migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              // Minimal worker: keeps TanStack virtual modules out of tests.
              main: "./tests/worker.ts",
              // `test` env: no remote-only bindings, so no credentials needed.
              wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/**/*.test.ts"],
            exclude: ["tests/**/*.node.test.ts", "tests/architecture.test.ts"],
            setupFiles: ["./tests/setup/apply-migrations.ts"],
          },
        },
        {
          test: {
            name: "node",
            environment: "node",
            include: ["tests/**/*.node.test.ts", "tests/architecture.test.ts"],
          },
        },
      ],
    },
  };
});
