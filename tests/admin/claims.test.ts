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

    // Insert pending claim for current revision 2
    const pendingClaim = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 2, 'pv1', 'model-1', 'Pending fact claim', 'fact', 'verified', 'pending_review', 1, 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

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
