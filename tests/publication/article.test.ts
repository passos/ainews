import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getArticlePage } from "../../src/server/publication/articles";
import { getEventEvidence } from "../../src/server/publication/evidence";
import {
  db,
  resetPublication,
  seedAnalysis,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "./helpers";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setDisplay(sourceId: number, value: string): Promise<void> {
  await env.DB.prepare("UPDATE sources SET content_display = ?1 WHERE id = ?2")
    .bind(value, sourceId)
    .run();
}

async function putBody(id: number, sha: string, text: string): Promise<void> {
  await env.BODIES.put(`bodies/${id}/${sha}.md`, text);
}

/** A bucket that counts `get` calls and delegates to the test R2. */
function countingBucket(impl?: (key: string) => Promise<R2ObjectBody | null>) {
  const calls: string[] = [];
  return {
    calls,
    bucket: {
      get: (key: string) => {
        calls.push(key);
        return impl ? impl(key) : env.BODIES.get(key);
      },
    } as Pick<R2Bucket, "get">,
  };
}

const words = (marker: string, n: number) =>
  [marker, ...Array.from({ length: n - 1 }, () => "w")].join(" ");
const tenParas = Array.from({ length: 10 }, (_, i) =>
  words(`PARA${i + 1}MARK`, 50),
).join("\n\n");

async function approvedFull(o: { summary?: string } = {}) {
  const id = await seedArticle({
    ...tech,
    title: "Reader",
    summary: o.summary ?? "Feed summary.",
    bodyKind: "full",
  });
  await seedReview(id, "approved");
  return id;
}

describe("getArticlePage", () => {
  it("full source: renders the approved body, not excerpted", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await approvedFull();
    await putBody(id, "sha-current", "# Head\n\nBODYMARK text.");
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page).not.toBeNull();
    expect(page!.article.id).toBe(id);
    expect(page!.bodyHtml).toContain("BODYMARK");
    expect(page!.excerpted).toBe(false);
  });

  it("is null when only an older version is approved, rejected, or not reviewed", async () => {
    await setDisplay(tech.sourceId, "full");
    const older = await seedArticle({
      ...tech,
      title: "Older",
      bodyKind: "full",
    });
    await seedReview(older, "approved", "sha-older");
    const rejected = await seedArticle({
      ...tech,
      title: "Rej",
      bodyKind: "full",
    });
    await seedReview(rejected, "rejected");
    const none = await seedArticle({
      ...tech,
      title: "None",
      bodyKind: "full",
    });
    for (const id of [older, rejected, none]) {
      await putBody(id, "sha-current", "BODYMARK");
      expect(await getArticlePage(db(), env.BODIES, id)).toBeNull();
    }
  });

  it("shows only the approved version when R2 has two", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await approvedFull();
    await putBody(id, "sha-older", "OLDMARK");
    await putBody(id, "sha-current", "NEWMARK");
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.bodyHtml).toContain("NEWMARK");
    expect(page!.bodyHtml).not.toContain("OLDMARK");
  });

  it("summary source: no body and no R2 read", async () => {
    await setDisplay(tech.sourceId, "summary");
    const id = await approvedFull();
    await putBody(id, "sha-current", "BODYMARK");
    const { calls, bucket } = countingBucket();
    const page = await getArticlePage(db(), bucket, id);
    expect(page!.bodyHtml).toBeNull();
    expect(calls).toHaveLength(0);
    expect(page!.article.summary).toBe("Feed summary.");
  });

  it("body_kind summary: no body and no R2 read", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await seedArticle({ ...tech, title: "S", bodyKind: "summary" });
    await seedReview(id, "approved");
    await putBody(id, "sha-current", "BODYMARK");
    const { calls, bucket } = countingBucket();
    const page = await getArticlePage(db(), bucket, id);
    expect(page!.bodyHtml).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("falls back to summary and link when R2 has no object", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await approvedFull();
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.bodyHtml).toBeNull();
    expect(page!.article.summary).toBe("Feed summary.");
    expect(page!.article.url).toMatch(/^https:\/\/news\.example\//);
  });

  it("falls back without throwing when R2 throws", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await approvedFull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bucket } = countingBucket(() =>
      Promise.reject(new Error("r2 down")),
    );
    const page = await getArticlePage(db(), bucket, id);
    expect(page!.bodyHtml).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("r2 down");
  });

  it("excerpt source: first blocks only, no images", async () => {
    await setDisplay(tech.sourceId, "excerpt");
    const id = await approvedFull();
    await putBody(
      id,
      "sha-current",
      `![IMGALT](https://i.example/p.png)\n\n${tenParas}`,
    );
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.excerpted).toBe(true);
    expect(page!.bodyHtml).toContain("PARA1MARK");
    expect(page!.bodyHtml).toContain("PARA2MARK");
    expect(page!.bodyHtml).not.toContain("PARA3MARK");
    expect(page!.bodyHtml).not.toContain("<img");
    expect(page!.bodyHtml).toContain("IMGALT");
  });

  it("full source keeps https images", async () => {
    await setDisplay(tech.sourceId, "full");
    const id = await approvedFull();
    await putBody(
      id,
      "sha-current",
      "![IMGALT](https://i.example/p.png)\n\ntext",
    );
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.bodyHtml).toContain('<img src="https://i.example/p.png"');
  });

  it("treats an unknown content_display as excerpt", async () => {
    await setDisplay(tech.sourceId, "bogus");
    const id = await approvedFull();
    await putBody(id, "sha-current", tenParas);
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.excerpted).toBe(true);
    expect(page!.bodyHtml).not.toContain("PARA3MARK");
  });

  it("new sources default to excerpt", async () => {
    const id = await approvedFull();
    await putBody(id, "sha-current", tenParas);
    const page = await getArticlePage(db(), env.BODIES, id);
    expect(page!.excerpted).toBe(true);
  });

  it("summaryKind: editor, ai, feed", async () => {
    const editor = await seedArticle({
      ...tech,
      title: "E",
      summary: "feed",
      summaryOverride: "Edited.",
    });
    await seedAnalysis(editor, { summaryEn: "AI text." });
    const ai = await seedArticle({ ...tech, title: "A", summary: "feed" });
    await seedAnalysis(ai, { summaryEn: "AI text." });
    const feed = await seedArticle({ ...tech, title: "F", summary: "feed" });
    for (const id of [editor, ai, feed]) await seedReview(id, "approved");
    expect((await getArticlePage(db(), env.BODIES, editor))!.summaryKind).toBe(
      "editor",
    );
    expect((await getArticlePage(db(), env.BODIES, ai))!.summaryKind).toBe(
      "ai",
    );
    expect((await getArticlePage(db(), env.BODIES, feed))!.summaryKind).toBe(
      "feed",
    );
  });

  it("editorApproved is false only for an automatic approval", async () => {
    const human = await approvedFull();
    const auto = await approvedFull();
    await env.DB.prepare(
      "UPDATE reviews SET reviewer = 'auto' WHERE article_id = ?1",
    )
      .bind(auto)
      .run();
    expect(
      (await getArticlePage(db(), env.BODIES, human))!.editorApproved,
    ).toBe(true);
    expect((await getArticlePage(db(), env.BODIES, auto))!.editorApproved).toBe(
      false,
    );
  });

  it("bodyIsAbstract follows the source's summaryIsBody config", async () => {
    const plain = await approvedFull();
    expect(
      (await getArticlePage(db(), env.BODIES, plain))!.bodyIsAbstract,
    ).toBe(false);
    await env.DB.prepare("UPDATE sources SET config = ?1 WHERE id = ?2")
      .bind(JSON.stringify({ summaryIsBody: true }), tech.sourceId)
      .run();
    expect(
      (await getArticlePage(db(), env.BODIES, plain))!.bodyIsAbstract,
    ).toBe(true);
  });
});

describe("getEventEvidence inArticle", () => {
  async function citedArticle(o: {
    display: string;
    bodyKind: "full" | "summary" | null;
  }): Promise<{ eventId: number; articleId: number }> {
    await setDisplay(tech.sourceId, o.display);
    const eventId = await seedEvent(tech.industryId, "Event", 1);
    const articleId = await seedArticle({
      ...tech,
      title: "Cited",
      bodyKind: o.bodyKind,
    });
    await seedEventArticle(eventId, articleId);
    await seedReview(articleId, "approved");
    const claim = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 1, 'pv1', 'gemini', 'A claim', 'fact', 'verified', 'published', 0, 0) RETURNING id`,
    )
      .bind(eventId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, stance, quote, quote_clean, start_offset, end_offset, verified, is_primary_source, created_at)
       VALUES (?1, ?2, 'sha-current', 'support', 'Quoted words', 'Quoted words', 0, 12, 1, 0, 0)`,
    )
      .bind(claim!.id, articleId)
      .run();
    return { eventId, articleId };
  }

  for (const [display, bodyKind, expected] of [
    ["full", "full", true],
    ["excerpt", "full", false],
    ["summary", "full", false],
    ["full", "summary", false],
    ["full", null, false],
    ["bogus", "full", false],
  ] as const) {
    it(`${display} source, body_kind ${bodyKind} → inArticle ${expected}`, async () => {
      const { eventId } = await citedArticle({ display, bodyKind });
      const view = await getEventEvidence(db(), eventId);
      expect(view.claims[0].evidence[0].inArticle).toBe(expected);
    });
  }
});
