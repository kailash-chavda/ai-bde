import { validatePortfolioRefs } from "@ai-bde/orchestrator";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  actor: z.string().min(1).default("user:local-dev"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await ctx.params;
  const parsed = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const item = await query<{
    id: string;
    lead_id: string;
    body: string;
    matched_case_study_id: string | null;
    case_study_ids: string[];
    hitl_status: string;
    requires_hitl: boolean;
  }>(
    `SELECT id, lead_id, body, matched_case_study_id, case_study_ids,
            hitl_status::text, requires_hitl
     FROM outreach_items WHERE id = $1`,
    [itemId],
  );
  if (!item.rows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = item.rows[0];
  if (row.hitl_status !== "pending") {
    return NextResponse.json(
      { error: `Item is ${row.hitl_status}, not pending` },
      { status: 409 },
    );
  }

  const approved = await query<{ id: string }>(
    `SELECT id FROM case_studies WHERE approved = true AND archived_at IS NULL`,
  );
  const approvedIds = new Set(approved.rows.map((r) => r.id));
  const check = validatePortfolioRefs({
    body: row.body,
    matchedCaseStudyId: row.matched_case_study_id,
    caseStudyIds: row.case_study_ids ?? [],
    approvedCaseStudyIds: approvedIds,
  });
  if (!check.ok) {
    return NextResponse.json(
      { error: "Portfolio integrity failed", details: check.errors },
      { status: 422 },
    );
  }

  // Phase 1: HITL must be true — refuse if somehow false
  if (!row.requires_hitl) {
    return NextResponse.json(
      { error: "Phase 1 requires HITL on all sends" },
      { status: 422 },
    );
  }

  await query("BEGIN");
  try {
    await query(
      `UPDATE outreach_items
       SET hitl_status = 'approved', scheduled_at = COALESCE(scheduled_at, now()), updated_at = now()
       WHERE id = $1`,
      [itemId],
    );
    // Lead stays QueuedForApproval until dispatcher confirms send → Contacted
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       SELECT $1, state, state, $2, $3 FROM leads WHERE id = $1`,
      [
        row.lead_id,
        `HITL approved outreach ${itemId}; awaiting dispatcher`,
        parsed.data.actor,
      ],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  return NextResponse.json({ ok: true, itemId, status: "approved" });
}
