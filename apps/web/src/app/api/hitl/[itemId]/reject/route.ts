import { afterHitlReject, planTransition } from "@ai-bde/orchestrator";
import {
  runCopywriterAgentAsync,
  type CopywriterResult,
} from "@ai-bde/agents";
import type { AgencyLeadProfile, ApprovedCaseStudy } from "@ai-bde/schemas";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";

const BodySchema = z.object({
  reason: z.string().min(1),
  actor: z.string().min(1).default("user:local-dev"),
  rewrite: z.boolean().default(true),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await ctx.params;
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const item = await query<{
    id: string;
    lead_id: string;
    step_index: number;
    hitl_status: string;
    sequence_id: string | null;
    inbox_id: string | null;
  }>(
    `SELECT id, lead_id, step_index, hitl_status::text, sequence_id, inbox_id
     FROM outreach_items WHERE id = $1`,
    [itemId],
  );
  if (!item.rows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = item.rows[0];
  if (row.hitl_status !== "pending") {
    return NextResponse.json(
      { error: `Item is ${row.hitl_status}` },
      { status: 409 },
    );
  }

  const lead = await query<{
    state: string;
    profile: AgencyLeadProfile;
  }>(`SELECT state::text AS state, profile FROM leads WHERE id = $1`, [
    row.lead_id,
  ]);
  if (!lead.rows[0]?.profile) {
    return NextResponse.json({ error: "Lead profile missing" }, { status: 422 });
  }

  await query("BEGIN");
  try {
    await query(
      `UPDATE outreach_items
       SET hitl_status = 'rejected', rejection_reason = $2, updated_at = now()
       WHERE id = $1`,
      [itemId, parsed.data.reason],
    );

    // Step 1 reject → Enriched for rewrite; follow-up steps stay QueuedForApproval
    if (row.step_index <= 1) {
      const nextState = afterHitlReject("QueuedForApproval");
      const t = planTransition({
        from: "QueuedForApproval",
        to: nextState,
        reason: `HITL rejected: ${parsed.data.reason}`,
        actor: parsed.data.actor,
      });
      await query(
        `UPDATE leads SET state = $2, updated_at = now() WHERE id = $1`,
        [row.lead_id, t.to],
      );
      await query(
        `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.lead_id, t.from, t.to, t.reason, t.actor],
      );
    } else {
      await query(
        `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
         SELECT $1, state, state, $2, $3 FROM leads WHERE id = $1`,
        [
          row.lead_id,
          `HITL rejected follow-up step ${row.step_index}: ${parsed.data.reason}`,
          parsed.data.actor,
        ],
      );
    }

    let rewrite: CopywriterResult | null = null;
    if (parsed.data.rewrite) {
      const studies = await query<{
        id: string;
        slug: string;
        title: string;
        service_pillars: ApprovedCaseStudy["service_pillars"];
        industries: string[];
        tech_tags: string[];
        summary: string;
        outcomes: ApprovedCaseStudy["outcomes"];
        client_name: string | null;
        anonymized_label: string | null;
      }>(
        `SELECT id, slug, title, service_pillars, industries, tech_tags, summary,
                outcomes, client_name, anonymized_label
         FROM case_studies WHERE approved = true AND archived_at IS NULL`,
      );
      const approved: ApprovedCaseStudy[] = studies.rows.map((s) => ({
        ...s,
        approved: true as const,
      }));
      rewrite = await runCopywriterAgentAsync({
        leadId: row.lead_id,
        profile: lead.rows[0].profile,
        approvedCaseStudies: approved,
        stepIndex: row.step_index,
      });
      const idem = `${rewrite.draft.idempotency_key}:rewrite:${Date.now()}`;
      await query(
        `INSERT INTO outreach_items (
           lead_id, sequence_id, step_index, channel, subject, body, char_count,
           matched_case_study_id, case_study_ids, hitl_status, requires_hitl,
           inbox_id, idempotency_key
         ) VALUES (
           $1, $2, $3, 'email', $4, $5, $6, $7, $8::uuid[], 'pending', true, $9, $10
         )`,
        [
          row.lead_id,
          row.sequence_id,
          row.step_index,
          rewrite.draft.subject,
          rewrite.draft.body,
          rewrite.draft.char_count,
          rewrite.draft.matched_case_study_id,
          rewrite.draft.case_study_ids ?? [],
          row.inbox_id,
          idem,
        ],
      );
      if (row.step_index <= 1) {
        const queued = planTransition({
          from: "Enriched",
          to: "QueuedForApproval",
          reason: "Rewrite after HITL reject",
          actor: "agent:copywriter",
        });
        await query(
          `UPDATE leads SET state = $2, updated_at = now() WHERE id = $1`,
          [row.lead_id, queued.to],
        );
        await query(
          `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.lead_id, queued.from, queued.to, queued.reason, queued.actor],
        );
      } else {
        await query(
          `UPDATE leads SET state = 'QueuedForApproval', updated_at = now()
           WHERE id = $1 AND state <> 'QueuedForApproval'`,
          [row.lead_id],
        );
      }
      await query(
        `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
         VALUES ($1, 'copywriter', $2, $3::jsonb, $4, 'success')`,
        [
          row.lead_id,
          createHash("sha256").update(idem).digest("hex"),
          JSON.stringify(rewrite),
          rewrite.model,
        ],
      );
    }

    await query("COMMIT");
    return NextResponse.json({ ok: true, rewriteQueued: Boolean(rewrite) });
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }
}
