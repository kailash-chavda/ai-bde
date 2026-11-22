import {
  SEQUENCE_PAUSE_REASONS,
  isResumablePause,
  parseSequenceSteps,
  type SequencePauseReason,
} from "@ai-bde/orchestrator";
import { query } from "./db";
import { clearLeadSeqDue, enqueueSeqDue } from "./redis";
import { sendSlackAlert } from "./slack";

export async function loadLeadOutreachIds(leadId: string): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM outreach_items
     WHERE lead_id = $1 AND sent_at IS NULL AND hitl_status = 'approved'`,
    [leadId],
  );
  return rows.map((r) => r.id);
}

export async function pauseLeadSequence(input: {
  leadId: string;
  reason: SequencePauseReason | string;
  actor: string;
  cancel?: boolean;
  alertSlack?: boolean;
}): Promise<{ ok: boolean; status: string }> {
  const status = input.cancel ? "cancelled" : "paused";

  await query("BEGIN");
  try {
    await query(
      `UPDATE leads SET pause_reason = $2, updated_at = now() WHERE id = $1`,
      [input.leadId, input.reason],
    );
    await query(
      `UPDATE lead_sequences
       SET status = $2, paused_at = now()
       WHERE lead_id = $1 AND status = 'active'`,
      [input.leadId, status],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       SELECT $1, state, state, $2, $3 FROM leads WHERE id = $1`,
      [
        input.leadId,
        `Sequence ${status}: ${input.reason}`,
        input.actor,
      ],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  const ids = await loadLeadOutreachIds(input.leadId);
  await clearLeadSeqDue(ids);

  if (input.alertSlack !== false) {
    await sendSlackAlert({
      kind: "sequence_paused",
      text: `Sequence ${status} for lead ${input.leadId}`,
      fields: { reason: input.reason, actor: input.actor },
    });
  }

  return { ok: true, status };
}

export async function resumeLeadSequence(input: {
  leadId: string;
  actor: string;
}): Promise<{ ok: boolean; error?: string; requeued?: number }> {
  const lead = await query<{
    pause_reason: string | null;
    state: string;
  }>(`SELECT pause_reason, state::text AS state FROM leads WHERE id = $1`, [
    input.leadId,
  ]);
  const row = lead.rows[0];
  if (!row) return { ok: false, error: "Lead not found" };

  if (!isResumablePause(row.pause_reason)) {
    return {
      ok: false,
      error: `Cannot resume: pause_reason=${row.pause_reason} is terminal`,
    };
  }

  const terminalStates = new Set([
    "DoNotContact",
    "Disqualified",
    "DiscoveryBooked",
  ]);
  if (terminalStates.has(row.state)) {
    return { ok: false, error: `Cannot resume from state ${row.state}` };
  }

  await query("BEGIN");
  try {
    await query(
      `UPDATE leads SET pause_reason = NULL, updated_at = now() WHERE id = $1`,
      [input.leadId],
    );
    await query(
      `UPDATE lead_sequences
       SET status = 'active', paused_at = NULL
       WHERE lead_id = $1 AND status = 'paused'`,
      [input.leadId],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       SELECT $1, state, state, 'Sequence resumed', $2 FROM leads WHERE id = $1`,
      [input.leadId, input.actor],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  const due = await query<{ id: string; scheduled_at: Date | null }>(
    `SELECT id, scheduled_at FROM outreach_items
     WHERE lead_id = $1
       AND hitl_status = 'approved'
       AND sent_at IS NULL`,
    [input.leadId],
  );

  let requeued = 0;
  for (const item of due.rows) {
    const at = item.scheduled_at ? new Date(item.scheduled_at) : new Date();
    if (await enqueueSeqDue(item.id, at)) requeued += 1;
  }

  return { ok: true, requeued };
}

export async function getActiveSequence(leadId: string) {
  const { rows } = await query<{
    id: string;
    template_id: string;
    status: string;
    current_step: number;
    paused_at: Date | null;
    steps: unknown;
    template_name: string;
  }>(
    `SELECT ls.id, ls.template_id, ls.status, ls.current_step, ls.paused_at,
            st.steps, st.name AS template_name
     FROM lead_sequences ls
     JOIN sequence_templates st ON st.id = ls.template_id
     WHERE ls.lead_id = $1
     ORDER BY ls.created_at DESC
     LIMIT 1`,
    [leadId],
  );
  const seq = rows[0];
  if (!seq) return null;
  return {
    ...seq,
    steps: parseSequenceSteps(seq.steps),
  };
}

export { SEQUENCE_PAUSE_REASONS };
