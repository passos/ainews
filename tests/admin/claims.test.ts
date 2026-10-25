import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listPendingClaims, reviewClaim } from "../../src/server/admin/ops";

describe("admin claims operations", () => {
  it("lists pending claims and records approved/rejected decisions with revision check", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('admin-claim-ind', 'Admin Claim', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Admin Claim Event', 2, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      `INSERT INTO sources (name, site_domain, feed_url, kind, industry_id, created_at)
       VALUES ('Admin Test Source', 'example.com', 'https://example.com/rss', 'rss', ?1, 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, fetched_at)
       VALUES (?1, ?2, 'https://example.com/art1', 'https://example.com/art1', 'Test Article Title', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    // Insert pending claim for current revision 2
    const pendingClaim = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 2, 'pv1', 'model-1', 'Pending fact claim', 'fact', 'verified', 'pending_review', 1, 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    // Insert evidence citation for pending claim
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, verified, created_at)
       VALUES (?1, ?2, 'sha123', 'Key verbatim finding from paper.', 'Key verbatim finding from paper.', 10, 42, 'support', 1, 1, 1000)`,
    )
      .bind(pendingClaim!.id, art!.id)
      .run();

    // Insert old revision claim (should not appear in pending list for current revision)
    await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 1, 'pv1', 'model-1', 'Stale fact claim', 'fact', 'verified', 'pending_review', 0, 900)`,
    )
      .bind(event!.id)
      .run();

    // 1. listPendingClaims
    const pendingList = await listPendingClaims(env.DB);
    const found = pendingList.find((c) => c.id === pendingClaim!.id);
    expect(found).toBeDefined();
    expect(found?.eventTitle).toBe("Admin Claim Event");
    expect(found?.claimText).toBe("Pending fact claim");
    expect(found?.claimType).toBe("fact");
    expect(found?.consensusStatus).toBe("verified");
    expect(found?.inputRevision).toBe(2);
    expect(found?.citations).toHaveLength(1);
    expect(found?.citations[0]).toMatchObject({
      claimId: pendingClaim!.id,
      articleId: art!.id,
      articleTitle: "Test Article Title",
      articleUrl: "https://example.com/art1",
      sourceName: "Admin Test Source",
      quote: "Key verbatim finding from paper.",
      stance: "support",
      isPrimarySource: true,
      verified: true,
    });

    // Stale revision claim should not be in pending list because c.input_revision = e.revision
    const staleFound = pendingList.find(
      (c) => c.claimText === "Stale fact claim",
    );
    expect(staleFound).toBeUndefined();

    // 2. Reject stale revision decision: if expectedRevision is 1, reviewClaim returns false
    const staleResult = await reviewClaim(env.DB, {
      claimId: pendingClaim!.id,
      decision: "approved",
      expectedRevision: 1, // Event revision is 2!
    });
    expect(staleResult).toBe(false);

    // Verify still pending_review
    const check1 = await env.DB.prepare(
      "SELECT status FROM claims WHERE id = ?1",
    )
      .bind(pendingClaim!.id)
      .first<{ status: string }>();
    expect(check1?.status).toBe("pending_review");

    // 3. Approve with correct expectedRevision 2 -> success
    const approveResult = await reviewClaim(env.DB, {
      claimId: pendingClaim!.id,
      decision: "approved",
      expectedRevision: 2,
    });
    expect(approveResult).toBe(true);

    const check2 = await env.DB.prepare(
      "SELECT status FROM claims WHERE id = ?1",
    )
      .bind(pendingClaim!.id)
      .first<{ status: string }>();
    expect(check2?.status).toBe("published");

    // 4. Test reject
    const claimToReject = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 2, 'pv1', 'model-1', 'Claim to reject', 'interpretation', 'disputed', 'pending_review', 0, 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    const rejectResult = await reviewClaim(env.DB, {
      claimId: claimToReject!.id,
      decision: "rejected",
      expectedRevision: 2,
    });
    expect(rejectResult).toBe(true);

    const check3 = await env.DB.prepare(
      "SELECT status FROM claims WHERE id = ?1",
    )
      .bind(claimToReject!.id)
      .first<{ status: string }>();
    expect(check3?.status).toBe("rejected");
  });
});
