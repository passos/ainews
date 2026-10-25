import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createQuestion,
  getQuestion,
  listQuestions,
} from "../../src/server/admin/ops";

describe("Admin Ask Operations", () => {
  it("creates, retrieves, and lists research questions", async () => {
    // Insert industry
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, created_at)
       VALUES ('ask-ind', 'Ask Industry', 'review', 1000) RETURNING id`,
    ).first<{ id: number }>();

    // Insert event
    const event = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (?1, 'Admin Ask Event', 1, 1000, 1000) RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    // Create global question
    const q1Id = await createQuestion(
      env.DB,
      {
        question: "What are the latest LLM benchmarks?",
        scopeType: "global",
      },
      1000,
    );
    expect(q1Id).toBeGreaterThan(0);

    // Create event question
    const q2Id = await createQuestion(
      env.DB,
      {
        question: "What does this specific event say?",
        scopeType: "event",
        eventId: event!.id,
      },
      2000,
    );
    expect(q2Id).toBeGreaterThan(0);

    // Get single question
    const q1 = await getQuestion(env.DB, q1Id);
    expect(q1).toBeDefined();
    expect(q1?.id).toBe(q1Id);
    expect(q1?.question).toBe("What are the latest LLM benchmarks?");
    expect(q1?.scopeType).toBe("global");
    expect(q1?.eventId).toBeNull();
    expect(q1?.status).toBe("pending");
    expect(q1?.refusal).toBe(false);

    const q2 = await getQuestion(env.DB, q2Id);
    expect(q2?.id).toBe(q2Id);
    expect(q2?.scopeType).toBe("event");
    expect(q2?.eventId).toBe(event!.id);

    // List questions
    const list = await listQuestions(env.DB, 10);
    const found1 = list.find((q) => q.id === q1Id);
    const found2 = list.find((q) => q.id === q2Id);
    expect(found1).toBeDefined();
    expect(found2).toBeDefined();
    expect(list[0].id).toBe(q2Id); // Ordered by created_at DESC
  });

  it("returns null for non-existent question", async () => {
    const q = await getQuestion(env.DB, 999999);
    expect(q).toBeNull();
  });
});
