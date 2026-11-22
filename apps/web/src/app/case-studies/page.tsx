import { ApproveClient } from "@/components/ApproveClient";
import { CaseStudyForm } from "@/components/CaseStudyForm";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CaseStudiesPage() {
  let rows: Array<{
    id: string;
    slug: string;
    title: string;
    approved: boolean;
    embedding_status: string;
    anonymized_label: string | null;
    client_name: string | null;
  }> = [];
  let error: string | null = null;

  try {
    const result = await query<(typeof rows)[number]>(`
      SELECT id, slug, title, approved, embedding_status, anonymized_label, client_name
      FROM case_studies
      WHERE archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100
    `);
    rows = result.rows;
  } catch (err) {
    error = err instanceof Error ? err.message : "DB error";
  }

  return (
    <>
      <h1>Case studies</h1>
      <p className="lede">
        RAG source of truth. Create unapproved, then approve to publish.
        Outcomes stay empty until approval. Copywriter only uses{" "}
        <code>approved=true</code> rows.
      </p>
      {error ? <div className="flash error">{error}</div> : null}
      <CaseStudyForm />
      <table className="table" style={{ marginTop: "2rem" }}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Label</th>
            <th>Approved</th>
            <th>Embed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.title}
                <div className="meta">{r.slug}</div>
              </td>
              <td>{r.anonymized_label ?? r.client_name ?? "—"}</td>
              <td>{r.approved ? "yes" : "no"}</td>
              <td>{r.embedding_status}</td>
              <td>
                {!r.approved ? (
                  <ApproveClient id={r.id} />
                ) : (
                  <span className="badge">live</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
