import { HitlQueue } from "@/components/HitlQueue";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

async function loadQueue() {
  try {
    const { rows } = await query<{
      id: string;
      lead_id: string;
      company: string;
      subject: string | null;
      body: string;
      matched_case_study_id: string | null;
      case_study_ids: string[];
      created_at: string;
      decision_maker: { full_name?: string; email?: string };
    }>(`
      SELECT o.id, o.lead_id, l.company, o.subject, o.body,
             o.matched_case_study_id, o.case_study_ids, o.created_at,
             l.decision_maker
      FROM outreach_items o
      JOIN leads l ON l.id = o.lead_id
      WHERE o.hitl_status = 'pending' AND o.channel = 'email'
      ORDER BY o.created_at ASC
      LIMIT 50
    `);
    return { rows, error: null as string | null };
  } catch (err) {
    return {
      rows: [],
      error:
        err instanceof Error
          ? err.message
          : "Database unavailable — start docker-compose and run migrations",
    };
  }
}

export default async function HomePage() {
  const { rows, error } = await loadQueue();

  return (
    <>
      <h1>HITL approval queue</h1>
      <p className="lede">
        Phase 1 requires human approval before every send. Drafts cite only
        approved case studies — never invent clients or metrics.
      </p>
      {error ? <div className="flash error">{error}</div> : null}
      <HitlQueue initialItems={rows} />
    </>
  );
}
