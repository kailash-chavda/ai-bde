import { planTransition, InvalidTransitionError } from "@ai-bde/orchestrator";
import { LeadStateSchema } from "@ai-bde/schemas";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  to: LeadStateSchema,
  reason: z.string().min(1),
  actor: z.string().min(1).default("user:manual"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const lead = await query<{ state: string }>(
    `SELECT state::text AS state FROM leads WHERE id = $1`,
    [id],
  );
  if (!lead.rows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const from = LeadStateSchema.parse(lead.rows[0].state);
  try {
    const t = planTransition({
      from,
      to: parsed.data.to,
      reason: parsed.data.reason,
      actor: parsed.data.actor,
    });
    await query("BEGIN");
    try {
      await query(
        `UPDATE leads SET state = $2, updated_at = now() WHERE id = $1`,
        [id, t.to],
      );
      await query(
        `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, t.from, t.to, t.reason, t.actor],
      );
      await query("COMMIT");
    } catch (err) {
      await query("ROLLBACK");
      throw err;
    }
    return NextResponse.json({ ok: true, transition: t });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
