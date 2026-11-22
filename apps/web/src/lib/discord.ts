/**
 * Discord incoming webhook alerts (Phase 2 slice A).
 * No-op when DISCORD_WEBHOOK_URL is unset — safe for local dry-run.
 * Payload: { content } (Discord limit 2000 chars; keep messages short).
 */

export type DiscordAlertKind =
  | "hitl_approve_enqueue"
  | "high_intent_reply"
  | "calendar_booked"
  | "sequence_paused"
  | "opt_out";

export async function sendDiscordAlert(input: {
  kind: DiscordAlertKind;
  text: string;
  fields?: Record<string, string | number | boolean | null | undefined>;
}): Promise<{ sent: boolean; skipped?: string }> {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) {
    console.log(`[discord:skip] ${input.kind}: ${input.text}`);
    return { sent: false, skipped: "DISCORD_WEBHOOK_URL unset" };
  }

  const lines = [`**${input.kind}** — ${input.text}`];
  if (input.fields) {
    for (const [k, v] of Object.entries(input.fields)) {
      if (v === undefined || v === null || v === "") continue;
      lines.push(`• ${k}: ${String(v)}`);
    }
  }

  // Discord content max 2000; keep alerts terse
  let content = lines.join("\n");
  if (content.length > 1900) {
    content = `${content.slice(0, 1890)}…`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(`[discord:error] ${res.status} ${await res.text()}`);
      return { sent: false, skipped: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("[discord:error]", err);
    return { sent: false, skipped: "network_error" };
  }
}
