import {
  classifyReplyStub,
  runTriageAgentStub,
} from "@ai-bde/agents";
import {
  SEQUENCE_PAUSE_REASONS,
  isHighIntentClassification,
  planTransition,
} from "@ai-bde/orchestrator";
import type { LeadState } from "@ai-bde/schemas";
import { query } from "@/lib/db";
import { pauseLeadSequence } from "@/lib/sequences";
import { sendDiscordAlert } from "@/lib/discord";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Inbound reply stub (IMAP listener is Phase 3).
 * Pauses sequence on any reply; opt-out → suppression + DoNotContact;
 * high-intent classifications fire Discord when DISCORD_WEBHOOK_URL is set.
 */
const BodySchema = z.object({
  lead_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  thread_id: z.string().min(1).default("manual"),
  raw_body: z.string().min(1),
  raw_message_id: z.string().optional(),
});

async function transitionLead(
  leadId: string,
  from: LeadState,
  to: LeadState,
  reason: string,
  actor: string,
): Promise<void> {
  const t = planTransition({ from, to, reason, actor });
  await query(
    `UPDATE leads SET state = $2, updated_at = now() WHERE id = $1`,
    [leadId, t.to],
  );
  await query(
    `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
     VALUES ($1, $2, $3, $4, $5)`,
    [leadId, t.from, t.to, t.reason, t.actor],
  );
}

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let leadId = parsed.data.lead_id;
  if (!leadId && parsed.data.email) {
    const found = await query<{ id: string }>(
      `SELECT id FROM leads
       WHERE decision_maker->>'email' = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [parsed.data.email],
    );
    leadId = found.rows[0]?.id;
  }
  if (!leadId) {
    return NextResponse.json(
      { error: "Provide lead_id or matching email" },
      { status: 404 },
    );
  }

  const lead = await query<{
    state: string;
    company: string;
    decision_maker: { email?: string };
    domain: string;
  }>(
    `SELECT state::text AS state, company, decision_maker, domain
     FROM leads WHERE id = $1`,
    [leadId],
  );
  if (!lead.rows[0]) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const triage = runTriageAgentStub({
    leadId,
    threadId: parsed.data.thread_id,
    rawBody: parsed.data.raw_body,
  });
  const classified = classifyReplyStub(parsed.data.raw_body);

  if (parsed.data.raw_message_id) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM inbound_events WHERE raw_message_id = $1`,
      [parsed.data.raw_message_id],
    );
    if (existing.rows[0]) {
      return NextResponse.json({
        ok: true,
        deduped: true,
        inboundId: existing.rows[0].id,
      });
    }
  }

  await query("BEGIN");
  let inboundId: string;
  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO inbound_events (
         lead_id, thread_id, channel, raw_message_id, raw_body,
         classification, classification_confidence, urgency,
         extracted_requirements, suggested_reply, escalate_to_human,
         escalation_reason, received_at, processed_at
       ) VALUES (
         $1, $2, 'email_inbound', $3, $4,
         $5::reply_classification, $6, $7,
         '[]'::jsonb, NULL, $8, $9, now(), now()
       )
       RETURNING id`,
      [
        leadId,
        parsed.data.thread_id,
        parsed.data.raw_message_id ?? null,
        parsed.data.raw_body,
        triage.classification,
        triage.classification_confidence ?? 0,
        triage.urgency,
        triage.escalate_to_human,
        triage.escalation_reason,
      ],
    );
    inboundId = inserted.rows[0]!.id;
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  const from = lead.rows[0].state as LeadState;

  if (classified.classification === "unsubscribe") {
    const email = lead.rows[0].decision_maker?.email ?? null;
    if (email) {
      const existing = await query(
        `SELECT 1 FROM suppression_list WHERE email = $1::citext LIMIT 1`,
        [email],
      );
      if (!existing.rows[0]) {
        await query(
          `INSERT INTO suppression_list (email, domain, reason, source)
           VALUES ($1::citext, $2, 'unsubscribe', 'inbound_reply')`,
          [email, lead.rows[0].domain],
        );
      }
    }

    if (from !== "DoNotContact") {
      try {
        await transitionLead(
          leadId,
          from,
          "DoNotContact",
          "Inbound unsubscribe / opt-out",
          "system:inbound",
        );
      } catch {
        await query(
          `UPDATE leads SET state = 'DoNotContact', updated_at = now() WHERE id = $1`,
          [leadId],
        );
      }
    }

    await pauseLeadSequence({
      leadId,
      reason: SEQUENCE_PAUSE_REASONS.optOut,
      actor: "system:inbound",
      cancel: true,
      alert: false,
    });

    await sendDiscordAlert({
      kind: "opt_out",
      text: `Opt-out / unsubscribe: ${lead.rows[0].company}`,
      fields: { lead_id: leadId, inbound_id: inboundId },
    });

    return NextResponse.json({
      ok: true,
      inboundId,
      classification: "unsubscribe",
      state: "DoNotContact",
      sequence: "cancelled",
    });
  }

  await pauseLeadSequence({
    leadId,
    reason: SEQUENCE_PAUSE_REASONS.reply,
    actor: "system:inbound",
    cancel: false,
    alert: false,
  });

  try {
    if (from === "Contacted") {
      await transitionLead(
        leadId,
        "Contacted",
        "Replied",
        `Inbound reply classified ${classified.classification}`,
        "system:inbound",
      );
    } else if (from === "QueuedForApproval") {
      await transitionLead(
        leadId,
        "QueuedForApproval",
        "Contacted",
        "Inbound reply while awaiting send — mark contacted",
        "system:inbound",
      );
      await transitionLead(
        leadId,
        "Contacted",
        "Replied",
        `Inbound reply classified ${classified.classification}`,
        "system:inbound",
      );
    }
  } catch (err) {
    console.error("reply transition failed", err);
  }

  if (isHighIntentClassification(classified.classification)) {
    await sendDiscordAlert({
      kind: "high_intent_reply",
      text: `High-intent reply: ${lead.rows[0].company}`,
      fields: {
        lead_id: leadId,
        classification: classified.classification,
        urgency: classified.urgency,
        inbound_id: inboundId,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    inboundId,
    classification: classified.classification,
    urgency: classified.urgency,
    sequence: "paused",
    highIntent: isHighIntentClassification(classified.classification),
  });
}
