import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle/migrations",
});
