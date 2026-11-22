import {
  computeScheduledAt,
  parseSequenceSteps,
  validatePortfolioRefs,
} from "@ai-bde/orchestrator";
import { query } from "@/lib/db";
import { enqueueSeqDue } from "@/lib/redis";
import { sendDiscordAlert } from "@/lib/discord";
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
    step_index: number;
    sequence_id: string | null;
  }>(
    `SELECT id, lead_id, body, matched_case_study_id, case_study_ids,
            hitl_status::text, requires_hitl, step_index, sequence_id
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

  const lead = await query<{
    company: string;
    pause_reason: string | null;
    tier: string | null;
  }>(
    `SELECT company, pause_reason, tier FROM leads WHERE id = $1`,
    [row.lead_id],
  );
  if (lead.rows[0]?.pause_reason) {
    return NextResponse.json(
      { error: `Lead sequence paused: ${lead.rows[0].pause_reason}` },
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

  if (!row.requires_hitl) {
    return NextResponse.json(
      { error: "HITL required on email sends in Phase 2 slice A" },
      { status: 422 },
    );
  }

  let delayBusinessDays = 0;
  if (row.sequence_id) {
    const seq = await query<{ steps: unknown }>(
      `SELECT st.steps
       FROM lead_sequences ls
       JOIN sequence_templates st ON st.id = ls.template_id
       WHERE ls.id = $1`,
      [row.sequence_id],
    );
    if (seq.rows[0]) {
      const steps = parseSequenceSteps(seq.rows[0].steps);
      const step = steps.find((s) => s.step_index === row.step_index);
      delayBusinessDays = step?.delay_business_days ?? 0;
    }
  }

  const lastSent = await query<{ sent_at: Date | null }>(
    `SELECT sent_at FROM outreach_items
     WHERE lead_id = $1 AND sent_at IS NOT NULL
     ORDER BY step_index DESC LIMIT 1`,
    [row.lead_id],
  );

  const scheduledAt = computeScheduledAt({
    delayBusinessDays,
    lastSentAt: lastSent.rows[0]?.sent_at
      ? new Date(lastSent.rows[0].sent_at)
      : null,
  });

  await query("BEGIN");
  try {
    await query(
      `UPDATE outreach_items
       SET hitl_status = 'approved', scheduled_at = $2, updated_at = now()
       WHERE id = $1`,
      [itemId, scheduledAt.toISOString()],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       SELECT $1, state, state, $2, $3 FROM leads WHERE id = $1`,
      [
        row.lead_id,
        `HITL approved outreach ${itemId} step ${row.step_index}; enqueued for dispatcher`,
        parsed.data.actor,
      ],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  const zadd = await enqueueSeqDue(itemId, scheduledAt);

  await sendDiscordAlert({
    kind: "hitl_approve_enqueue",
    text: `HITL approved → send queue: ${lead.rows[0]?.company ?? row.lead_id}`,
    fields: {
      lead_id: row.lead_id,
      outreach_item_id: itemId,
      step: row.step_index,
      scheduled_at: scheduledAt.toISOString(),
      redis_zset: zadd,
      tier: lead.rows[0]?.tier,
      actor: parsed.data.actor,
    },
  });

  return NextResponse.json({
    ok: true,
    itemId,
    status: "approved",
    scheduledAt: scheduledAt.toISOString(),
    redisEnqueued: zadd,
  });
}
