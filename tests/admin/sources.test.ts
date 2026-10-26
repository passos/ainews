import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { contentDisplaySchema } from "../../src/lib/content-display";
import {
  createSource,
  listSources,
  updateSource,
} from "../../src/server/admin/ops";
import { resetPublication, seedSections } from "../publication/helpers";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

const displayOf = async (id: number) =>
  (
    await env.DB.prepare("SELECT content_display FROM sources WHERE id = ?1")
      .bind(id)
      .first<{ content_display: string }>()
  )?.content_display;

const base = {
  name: "Technology Wire",
  feedUrl: "https://technology.example/feed",
  siteDomain: "technology.example",
};

describe("source content_display", () => {
  it("updateSource sets it and keeps it when not given", async () => {
    await updateSource(env.DB, {
      id: tech.sourceId,
      ...base,
      contentDisplay: "full",
    });
    expect(await displayOf(tech.sourceId)).toBe("full");
    await updateSource(env.DB, { id: tech.sourceId, ...base });
    expect(await displayOf(tech.sourceId)).toBe("full");
  });

  it("createSource defaults to excerpt", async () => {
    const id = await createSource(env.DB, {
      industryId: tech.industryId,
      name: "New",
      feedUrl: "https://new.example/feed",
      kind: "rss",
    });
    expect(await displayOf(id!)).toBe("excerpt");
  });

  it("createSource stores a given value; listSources returns it", async () => {
    const id = await createSource(env.DB, {
      industryId: tech.industryId,
      name: "Gov",
      feedUrl: "https://gov.example/feed",
      kind: "rss",
      contentDisplay: "full",
    });
    expect(await displayOf(id!)).toBe("full");
    const rows = await listSources(env.DB);
    expect(rows.find((r) => r.id === id)?.contentDisplay).toBe("full");
  });

  it("the write schema rejects an unknown value", () => {
    expect(contentDisplaySchema.safeParse("bogus").success).toBe(false);
    expect(contentDisplaySchema.safeParse("summary").success).toBe(true);
  });
});
