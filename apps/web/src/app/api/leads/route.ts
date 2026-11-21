import { LeadStateSchema } from "@ai-bde/schemas";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const pillar = url.searchParams.get("pillar");
  const geography = url.searchParams.get("geography");

  const filters: string[] = [];
  const params: unknown[] = [];

  if (state) {
    const parsed = LeadStateSchema.safeParse(state);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid state" }, { status: 400 });
    }
    params.push(parsed.data);
    filters.push(`state = $${params.length}`);
  }
  if (pillar) {
    params.push(pillar);
    filters.push(`matched_pillar = $${params.length}::service_pillar`);
  }
  if (geography) {
    params.push(geography);
    filters.push(`geography = $${params.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT id, company, domain, state::text, source, matched_pillar::text,
            geography, confidence_score, created_at
     FROM leads ${where}
     ORDER BY created_at DESC
     LIMIT 200`,
    params,
  );
  return NextResponse.json({ leads: rows });
}
