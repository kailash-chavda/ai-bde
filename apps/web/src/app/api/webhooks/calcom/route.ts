import {
  SEQUENCE_PAUSE_REASONS,
  planTransition,
} from "@ai-bde/orchestrator";
import {
  getCalcomWebhookSecret,
  verifyCalcomSignature,
} from "@/lib/calcom";
import { query } from "@/lib/db";
import { pauseLeadSequence } from "@/lib/sequences";
import { sendDiscordAlert } from "@/lib/discord";
import { NextResponse } from "next/server";

type CalcomWebhookBody = {
  triggerEvent?: string;
  payload?: {
    metadata?: { lead_id?: string };
    attendees?: Array<{ email?: string }>;
    uid?: string;
    bookingUid?: string;
  };
};

/**
 * Cal.com webhook — BOOKING_CREATED / booking.created →
 * lead DiscoveryBooked, cancel active sequences, Discord alert.
 *
 * Match lead via payload.metadata.lead_id or first attendee email.
 * Auth: when CALCOM_WEBHOOK_SECRET (or legacy CAL_WEBHOOK_SECRET) is set,
 * require valid X-Cal-Signature-256 (HMAC-SHA256 of raw body).
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const secret = getCalcomWebhookSecret();
  if (secret) {
    const header = req.headers.get("x-cal-signature-256");
    if (!verifyCalcomSignature(rawBody, header, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: CalcomWebhookBody;
  try {
    body = JSON.parse(rawBody) as CalcomWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.triggerEvent ?? "";
  if (event !== "BOOKING_CREATED" && event !== "booking.created") {
    return NextResponse.json({ ok: true, ignored: event });
  }

  const bookingUid =
    body.payload?.uid ?? body.payload?.bookingUid ?? "unknown";
  const leadIdMeta = body.payload?.metadata?.lead_id;
  const attendeeEmail = body.payload?.attendees?.[0]?.email;

  let leadId = leadIdMeta;
  if (!leadId && attendeeEmail) {
    const found = await query<{ id: string; state: string }>(
      `SELECT id, state::text AS state FROM leads
       WHERE decision_maker->>'email' = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [attendeeEmail],
    );
    leadId = found.rows[0]?.id;
  }

  if (!leadId) {
    return NextResponse.json(
      { ok: false, error: "Could not match lead" },
      { status: 404 },
    );
  }

  const lead = await query<{ state: string; company: string }>(
    `SELECT state::text AS state, company FROM leads WHERE id = $1`,
    [leadId],
  );
  const from = lead.rows[0]?.state;
  if (!from) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  if (from === "DiscoveryBooked") {
    await pauseLeadSequence({
      leadId,
      reason: SEQUENCE_PAUSE_REASONS.calendar,
      actor: "system:cal.com",
      cancel: true,
      alert: false,
    });
    return NextResponse.json({
      ok: true,
      leadId,
      state: "DiscoveryBooked",
      idempotent: true,
    });
  }

  const allowedFrom = ["Contacted", "Replied"] as const;
  if (!allowedFrom.includes(from as (typeof allowedFrom)[number])) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: `state ${from} not transitioned`,
    });
  }

  const t = planTransition({
    from: from as "Contacted" | "Replied",
    to: "DiscoveryBooked",
    reason: `Cal.com booking ${bookingUid}`,
    actor: "system:cal.com",
  });

  await query("BEGIN");
  try {
    await query(
      `UPDATE leads SET state = $2, pause_reason = $3, updated_at = now() WHERE id = $1`,
      [leadId, t.to, SEQUENCE_PAUSE_REASONS.calendar],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [leadId, t.from, t.to, t.reason, t.actor],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  await pauseLeadSequence({
    leadId,
    reason: SEQUENCE_PAUSE_REASONS.calendar,
    actor: "system:cal.com",
    cancel: true,
    alert: false,
  });

  await sendDiscordAlert({
    kind: "calendar_booked",
    text: `Discovery booked: ${lead.rows[0]?.company ?? leadId}`,
    fields: {
      lead_id: leadId,
      booking_uid: bookingUid,
    },
  });

  return NextResponse.json({ ok: true, leadId, state: "DiscoveryBooked" });
}
