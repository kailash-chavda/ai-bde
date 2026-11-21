import { query } from "@/lib/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lead = await query<{
    id: string;
    company: string;
    domain: string;
    state: string;
    profile: unknown;
    decision_maker: unknown;
    disqualify_reason: string | null;
  }>(`SELECT id, company, domain, state::text, profile, decision_maker, disqualify_reason FROM leads WHERE id = $1`, [
    id,
  ]).catch(() => ({ rows: [] as never[] }));

  if (!lead.rows[0]) notFound();
  const row = lead.rows[0];

  const outreach = await query(
    `SELECT id, step_index, subject, hitl_status::text, matched_case_study_id, created_at
     FROM outreach_items WHERE lead_id = $1 ORDER BY step_index`,
    [id],
  ).catch(() => ({ rows: [] }));

  const transitions = await query(
    `SELECT from_state::text, to_state::text, reason, actor, created_at
     FROM state_transitions WHERE lead_id = $1 ORDER BY created_at`,
    [id],
  ).catch(() => ({ rows: [] }));

  return (
    <>
      <h1>{row.company}</h1>
      <p className="lede">
        {row.domain} · <span className="badge">{row.state}</span>
        {row.disqualify_reason ? ` · ${row.disqualify_reason}` : ""}
      </p>

      <h2>Outreach</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Subject</th>
            <th>HITL</th>
            <th>Case study</th>
          </tr>
        </thead>
        <tbody>
          {outreach.rows.map((o) => {
            const item = o as {
              id: string;
              step_index: number;
              subject: string | null;
              hitl_status: string;
              matched_case_study_id: string | null;
            };
            return (
              <tr key={item.id}>
                <td>{item.step_index}</td>
                <td>{item.subject}</td>
                <td>{item.hitl_status}</td>
                <td>{item.matched_case_study_id ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Transitions</h2>
      <table className="table">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th>Reason</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {transitions.rows.map((t, i) => {
            const rowT = t as {
              from_state: string | null;
              to_state: string;
              reason: string;
              actor: string;
            };
            return (
              <tr key={i}>
                <td>{rowT.from_state ?? "—"}</td>
                <td>{rowT.to_state}</td>
                <td>{rowT.reason}</td>
                <td>{rowT.actor}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Profile JSON</h2>
      <pre className="draft">{JSON.stringify(row.profile, null, 2)}</pre>
    </>
  );
}
