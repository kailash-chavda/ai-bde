import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  let rows: Array<{
    id: string;
    company: string;
    domain: string;
    state: string;
    matched_pillar: string | null;
    confidence_score: string | null;
    source: string;
    created_at: string;
  }> = [];
  let error: string | null = null;

  try {
    const result = await query<typeof rows[number]>(`
      SELECT id, company, domain, state::text, matched_pillar::text, confidence_score::text,
             source, created_at::text
      FROM leads
      ORDER BY created_at DESC
      LIMIT 100
    `);
    rows = result.rows;
  } catch (err) {
    error = err instanceof Error ? err.message : "DB error";
  }

  return (
    <>
      <h1>Leads</h1>
      <p className="lede">Pipeline states from ingest → research → HITL → contact.</p>
      {error ? <div className="flash error">{error}</div> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Company</th>
            <th>State</th>
            <th>Pillar</th>
            <th>Confidence</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <a href={`/leads/${r.id}`}>
                  {r.company}
                  <div className="meta">{r.domain}</div>
                </a>
              </td>
              <td>
                <span className="badge">{r.state}</span>
              </td>
              <td>{r.matched_pillar ?? "—"}</td>
              <td>{r.confidence_score ?? "—"}</td>
              <td>{r.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
