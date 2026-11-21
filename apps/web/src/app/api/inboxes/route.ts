import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const { rows } = await query(`
    SELECT id, email, display_name, provider, daily_send_cap, warmup_stage,
           timezone, send_window_start, send_window_end,
           spf_ok, dkim_ok, dmarc_ok, active
    FROM inboxes
    ORDER BY created_at
  `);
  return NextResponse.json({
    inboxes: rows.map((r) => ({
      ...r,
      note: "Phase 1: inbox stays inactive until SPF/DKIM/DMARC are true",
    })),
  });
}
