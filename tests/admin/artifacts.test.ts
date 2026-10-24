import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  listPendingArtifacts,
  reviewArtifact,
} from "../../src/server/admin/ops";

describe("admin artifacts operations", () => {
  it("lists pending artifacts and records approved/rejected decisions", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('admin-art-ind', 'Admin Art', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Admin Art Event', 2, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    // Insert two artifacts: one pending_review for revision 2, one published for old revision 1
    const pendingArt = await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'story_brief', '', 2, 'pv1', 'model-1', '{"whatHappened":"Brief 2"}', 'pending_review', 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'story_brief', '', 1, 'pv1', 'model-1', '{"whatHappened":"Brief 1"}', 'published', 900)`,
    )
      .bind(event!.id)
      .run();

    // 1. listPendingArtifacts should only return the pending_review artifact matching current revision
    const pendingList = await listPendingArtifacts(env.DB);
    const found = pendingList.find((a) => a.id === pendingArt!.id);
    expect(found).toBeDefined();
    expect(found?.eventTitle).toBe("Admin Art Event");
    expect(found?.inputRevision).toBe(2);

    // 2. Reject stale revision decision: if expectedRevision is 1, reviewArtifact should return false
    const staleResult = await reviewArtifact(env.DB, {
      artifactId: pendingArt!.id,
      decision: "approved",
      expectedRevision: 1, // Event revision is 2!
    });
    expect(staleResult).toBe(false);

    // Verify still pending_review
    const check1 = await env.DB.prepare(
      "SELECT status FROM event_artifacts WHERE id = ?1",
    )
      .bind(pendingArt!.id)
      .first<{ status: string }>();
    expect(check1?.status).toBe("pending_review");

    // 3. Approve with correct expectedRevision 2 -> success
    const approveResult = await reviewArtifact(env.DB, {
      artifactId: pendingArt!.id,
      decision: "approved",
      expectedRevision: 2,
    });
    expect(approveResult).toBe(true);

    const check2 = await env.DB.prepare(
      "SELECT status FROM event_artifacts WHERE id = ?1",
    )
      .bind(pendingArt!.id)
      .first<{ status: string }>();
    expect(check2?.status).toBe("published");

    // 4. Test reject
    const artToReject = await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'audience_explain', 'student', 2, 'pv1', 'model-1', '{"overview":"test"}', 'pending_review', 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    const rejectResult = await reviewArtifact(env.DB, {
      artifactId: artToReject!.id,
      decision: "rejected",
      expectedRevision: 2,
    });
    expect(rejectResult).toBe(true);

    const check3 = await env.DB.prepare(
      "SELECT status FROM event_artifacts WHERE id = ?1",
    )
      .bind(artToReject!.id)
      .first<{ status: string }>();
    expect(check3?.status).toBe("rejected");
  });
});
