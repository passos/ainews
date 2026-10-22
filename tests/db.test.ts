import { env } from "cloudflare:workers";
import { count } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/server/db/client";
import { settings } from "../src/server/db/schema";

it("migrations create an empty settings table", async () => {
  const rows = await getDb(env.DB).select({ n: count() }).from(settings);
  expect(rows).toEqual([{ n: 0 }]);
});
