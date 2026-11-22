import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const lead = await query(`SELECT * FROM leads WHERE id = $1`, [id]);
  if (!lead.rows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const outreach = await query(
    `SELECT * FROM outreach_items WHERE lead_id = $1 ORDER BY step_index, created_at`,
    [id],
  );
  const inbound = await query(
    `SELECT * FROM inbound_events WHERE lead_id = $1 ORDER BY received_at DESC`,
    [id],
  );
  const sequence = await query(
    `SELECT ls.*, st.name AS template_name, st.steps AS template_steps
     FROM lead_sequences ls
     JOIN sequence_templates st ON st.id = ls.template_id
     WHERE ls.lead_id = $1
     ORDER BY ls.created_at DESC
     LIMIT 1`,
    [id],
  );
  return NextResponse.json({
    lead: lead.rows[0],
    sequence: sequence.rows[0] ?? null,
    outreach: outreach.rows,
    inbound: inbound.rows,
  });
}
