import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cal.com helpers — webhook secret verification + optional booking link.
 *
 * Env (prefer new names; legacy CAL_WEBHOOK_SECRET still accepted):
 * - CALCOM_WEBHOOK_SECRET — HMAC key for X-Cal-Signature-256
 * - CALCOM_LINK — public booking URL shown in HITL / lead UI
 */

export function getCalcomWebhookSecret(): string | undefined {
  const next = process.env.CALCOM_WEBHOOK_SECRET?.trim();
  if (next) return next;
  const legacy = process.env.CAL_WEBHOOK_SECRET?.trim();
  return legacy || undefined;
}

export function getCalcomLink(): string | undefined {
  const link = process.env.CALCOM_LINK?.trim();
  return link || undefined;
}

/**
 * Build a Cal.com booking URL with lead attribution metadata.
 * Cal.com accepts `metadata[key]` query params that land on webhook payload.metadata.
 */
export function buildCalcomBookingUrl(opts: {
  leadId?: string;
  email?: string;
  name?: string;
}): string | null {
  const base = getCalcomLink();
  if (!base) return null;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }

  if (opts.leadId) {
    url.searchParams.set("metadata[lead_id]", opts.leadId);
  }
  if (opts.email) {
    url.searchParams.set("email", opts.email);
  }
  if (opts.name) {
    url.searchParams.set("name", opts.name);
  }
  return url.toString();
}

/**
 * Verify Cal.com X-Cal-Signature-256 (HMAC-SHA256 hex of raw body).
 * Also accepts the raw secret as the header value for local curl smoke tests
 * that match the previous stub behaviour.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyCalcomSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  if (timingSafeStringEqual(signatureHeader, expectedHex)) return true;
  // Local / legacy: header equals the secret string itself
  return timingSafeStringEqual(signatureHeader, secret);
}
