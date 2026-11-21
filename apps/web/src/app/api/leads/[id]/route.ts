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
    `SELECT * FROM outreach_items WHERE lead_id = $1 ORDER BY step_index`,
    [id],
  );
  const inbound = await query(
    `SELECT * FROM inbound_events WHERE lead_id = $1 ORDER BY received_at DESC`,
    [id],
  );
  return NextResponse.json({
    lead: lead.rows[0],
    outreach: outreach.rows,
    inbound: inbound.rows,
  });
}
