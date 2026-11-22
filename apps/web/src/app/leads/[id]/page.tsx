import { SequenceControls } from "@/components/SequenceControls";
import { buildCalcomBookingUrl } from "@/lib/calcom";
import { query } from "@/lib/db";
import { isResumablePause } from "@ai-bde/orchestrator";
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
    pause_reason: string | null;
  }>(
    `SELECT id, company, domain, state::text, profile, decision_maker,
            disqualify_reason, pause_reason
     FROM leads WHERE id = $1`,
    [id],
  ).catch(() => ({ rows: [] as never[] }));

  if (!lead.rows[0]) notFound();
  const row = lead.rows[0];
  const dm = (row.decision_maker ?? {}) as {
    full_name?: string;
    email?: string;
  };
  const bookingUrl = buildCalcomBookingUrl({
    leadId: id,
    email: dm.email,
    name: dm.full_name,
  });

  const sequence = await query<{
    id: string;
    status: string;
    current_step: number;
    paused_at: Date | null;
    template_name: string;
    steps: unknown;
  }>(
    `SELECT ls.id, ls.status, ls.current_step, ls.paused_at,
            st.name AS template_name, st.steps
     FROM lead_sequences ls
     JOIN sequence_templates st ON st.id = ls.template_id
     WHERE ls.lead_id = $1
     ORDER BY ls.created_at DESC
     LIMIT 1`,
    [id],
  ).catch(() => ({ rows: [] as never[] }));

  const seq = sequence.rows[0] ?? null;

  const outreach = await query(
    `SELECT id, step_index, subject, hitl_status::text, matched_case_study_id,
            scheduled_at, sent_at, created_at
     FROM outreach_items WHERE lead_id = $1 ORDER BY step_index, created_at`,
    [id],
  ).catch(() => ({ rows: [] }));

  const transitions = await query(
    `SELECT from_state::text, to_state::text, reason, actor, created_at
     FROM state_transitions WHERE lead_id = $1 ORDER BY created_at`,
    [id],
  ).catch(() => ({ rows: [] }));

  const stepCount = Array.isArray(seq?.steps) ? seq.steps.length : null;

  return (
    <>
      <h1>{row.company}</h1>
      <p className="lede">
        {row.domain} · <span className="badge">{row.state}</span>
        {row.disqualify_reason ? ` · ${row.disqualify_reason}` : ""}
        {row.pause_reason ? ` · paused: ${row.pause_reason}` : ""}
      </p>
      {bookingUrl ? (
        <p className="lede">
          <a href={bookingUrl} target="_blank" rel="noreferrer">
            Book discovery (Cal.com)
          </a>
          <span className="meta"> · embeds lead_id for webhook matching</span>
        </p>
      ) : null}

      <h2>Sequence</h2>
      {seq ? (
        <>
          <p className="lede">
            {seq.template_name} · status{" "}
            <span className="badge">{seq.status}</span> · step{" "}
            {seq.current_step}
            {stepCount ? ` / ${stepCount}` : ""}
            {seq.paused_at
              ? ` · paused at ${new Date(seq.paused_at).toISOString()}`
              : ""}
          </p>
          <SequenceControls
            leadId={id}
            status={seq.status}
            pauseReason={row.pause_reason}
            resumable={isResumablePause(row.pause_reason)}
          />
        </>
      ) : (
        <p className="lede">No sequence instance for this lead.</p>
      )}

      <h2>Outreach</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Subject</th>
            <th>HITL</th>
            <th>Scheduled</th>
            <th>Sent</th>
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
              scheduled_at: Date | null;
              sent_at: Date | null;
            };
            return (
              <tr key={item.id}>
                <td>{item.step_index}</td>
                <td>{item.subject}</td>
                <td>{item.hitl_status}</td>
                <td>
                  {item.scheduled_at
                    ? new Date(item.scheduled_at).toISOString()
                    : "—"}
                </td>
                <td>
                  {item.sent_at ? new Date(item.sent_at).toISOString() : "—"}
                </td>
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
