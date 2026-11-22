import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const { rows } = await query(`
    SELECT o.id, o.lead_id, l.company, o.subject, o.body, o.channel::text,
           o.matched_case_study_id, o.case_study_ids, o.hitl_status::text,
           o.created_at, l.decision_maker
    FROM outreach_items o
    JOIN leads l ON l.id = o.lead_id
    WHERE o.hitl_status = 'pending'
    ORDER BY o.created_at ASC
    LIMIT 100
  `);
  return NextResponse.json({ items: rows });
}
