/**
 * Slack incoming webhook alerts (Phase 2 slice A).
 * No-op when SLACK_WEBHOOK_URL is unset — safe for local dry-run.
 */

export type SlackAlertKind =
  | "hitl_approve_enqueue"
  | "high_intent_reply"
  | "calendar_booked"
  | "sequence_paused"
  | "opt_out";

export async function sendSlackAlert(input: {
  kind: SlackAlertKind;
  text: string;
  fields?: Record<string, string | number | boolean | null | undefined>;
}): Promise<{ sent: boolean; skipped?: string }> {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!url) {
    console.log(`[slack:skip] ${input.kind}: ${input.text}`);
    return { sent: false, skipped: "SLACK_WEBHOOK_URL unset" };
  }

  const lines = [input.text];
  if (input.fields) {
    for (const [k, v] of Object.entries(input.fields)) {
      if (v === undefined || v === null || v === "") continue;
      lines.push(`• *${k}:* ${String(v)}`);
    }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
    if (!res.ok) {
      console.error(`[slack:error] ${res.status} ${await res.text()}`);
      return { sent: false, skipped: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("[slack:error]", err);
    return { sent: false, skipped: "network_error" };
  }
}
