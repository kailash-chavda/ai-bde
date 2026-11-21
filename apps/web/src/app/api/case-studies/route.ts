import { CaseStudyCreateSchema } from "@ai-bde/schemas";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const { rows } = await query(
    `SELECT id, slug, title, service_pillars, industries, tech_tags, summary,
            outcomes, client_name, anonymized_label, approved, embedding_status, created_at
     FROM case_studies
     WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );
  return NextResponse.json({ caseStudies: rows });
}

export async function POST(req: Request) {
  const parsed = CaseStudyCreateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Unapproved rows must have empty outcomes (DB constraint)
  const { rows } = await query<{ id: string }>(
    `INSERT INTO case_studies (
       slug, title, service_pillars, industries, tech_tags, summary,
       outcomes, client_name, anonymized_label, approved
     ) VALUES (
       $1, $2, $3::service_pillar[], $4, $5, $6, '[]'::jsonb, $7, $8, false
     )
     RETURNING id`,
    [
      parsed.data.slug,
      parsed.data.title,
      parsed.data.service_pillars,
      parsed.data.industries,
      parsed.data.tech_tags,
      parsed.data.summary,
      parsed.data.client_name ?? null,
      parsed.data.anonymized_label ?? null,
    ],
  );

  return NextResponse.json({ id: rows[0]!.id, approved: false }, { status: 201 });
}
