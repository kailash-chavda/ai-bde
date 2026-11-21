import {
  evaluateDispatchGates,
  redisKeys,
} from "@ai-bde/orchestrator";
import { Redis } from "ioredis";
import nodemailer from "nodemailer";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://aibde:aibde@localhost:5432/aibde";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const POLL_MS = Number(process.env.DISPATCHER_POLL_MS ?? 5000);

interface DueItem {
  id: string;
  lead_id: string;
  subject: string | null;
  body: string;
  hitl_status: "pending" | "approved" | "rejected" | "sent";
  requires_hitl: boolean;
  case_study_ids: string[];
  inbox_id: string | null;
  idempotency_key: string;
  pause_reason: string | null;
  to_email: string | null;
}

async function loadDueItems(pool: pg.Pool): Promise<DueItem[]> {
  const { rows } = await pool.query<DueItem>(`
    SELECT o.id, o.lead_id, o.subject, o.body, o.hitl_status, o.requires_hitl,
           o.case_study_ids, o.inbox_id, o.idempotency_key,
           l.pause_reason,
           l.decision_maker->>'email' AS to_email
    FROM outreach_items o
    JOIN leads l ON l.id = o.lead_id
    WHERE o.channel = 'email'
      AND o.hitl_status = 'approved'
      AND o.sent_at IS NULL
      AND (o.scheduled_at IS NULL OR o.scheduled_at <= now())
      AND l.state = 'QueuedForApproval'
      AND l.pause_reason IS NULL
    ORDER BY o.created_at ASC
    LIMIT 20
  `);
  return rows;
}

async function isSuppressed(
  pool: pg.Pool,
  email: string | null,
  domain: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM suppression_list
     WHERE ($1::citext IS NOT NULL AND email = $1::citext)
        OR domain = $2
     LIMIT 1`,
    [email, domain],
  );
  return rows.length > 0;
}

async function approvedCaseStudyIds(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM case_studies WHERE approved = true AND archived_at IS NULL`,
  );
  return new Set(rows.map((r) => r.id));
}

function createTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
}

async function dispatchOne(
  pool: pg.Pool,
  redis: Redis,
  transport: nodemailer.Transporter | null,
  item: DueItem,
  approvedIds: Set<string>,
): Promise<void> {
  const lockKey = redisKeys.lockSend(item.idempotency_key);
  const locked = await redis.set(lockKey, "1", "EX", 86400, "NX");
  if (locked !== "OK") {
    console.log(`skip duplicate send ${item.idempotency_key}`);
    return;
  }

  const leadRes = await pool.query<{ domain: string }>(
    `SELECT domain FROM leads WHERE id = $1`,
    [item.lead_id],
  );
  const domain = leadRes.rows[0]?.domain ?? "";
  const suppressed = await isSuppressed(pool, item.to_email, domain);

  let inboxActive = true;
  let dailyCapRemaining = 40;
  let withinSendWindow = true;

  if (item.inbox_id) {
    const inbox = await pool.query<{
      active: boolean;
      daily_send_cap: number;
      spf_ok: boolean;
      dkim_ok: boolean;
      dmarc_ok: boolean;
    }>(`SELECT active, daily_send_cap, spf_ok, dkim_ok, dmarc_ok FROM inboxes WHERE id = $1`, [
      item.inbox_id,
    ]);
    const row = inbox.rows[0];
    inboxActive = Boolean(
      row?.active && row.spf_ok && row.dkim_ok && row.dmarc_ok,
    );
    const ymd = new Date().toISOString().slice(0, 10);
    const sentKey = redisKeys.inboxSent(item.inbox_id, ymd);
    const sent = Number((await redis.get(sentKey)) ?? "0");
    dailyCapRemaining = (row?.daily_send_cap ?? 40) - sent;
  } else if (!process.env.SMTP_HOST) {
    // Log-only mode without configured inbox auth — allow for local dry-run
    inboxActive = true;
  }

  const gate = evaluateDispatchGates({
    hitlStatus: item.hitl_status,
    requiresHitl: item.requires_hitl,
    suppressed,
    leadPaused: Boolean(item.pause_reason),
    caseStudyIds: item.case_study_ids ?? [],
    approvedCaseStudyIds: approvedIds,
    inboxActive: process.env.SMTP_HOST ? inboxActive : true,
    dailyCapRemaining,
    withinSendWindow,
  });

  if (!gate.allowed) {
    console.log(`blocked ${item.id}: ${gate.blockReasons.join(",")}`);
    await redis.del(lockKey);
    return;
  }

  let providerMessageId: string | null = null;
  if (transport && item.to_email) {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: item.to_email,
      subject: item.subject ?? "(no subject)",
      text: item.body,
      headers: {
        "List-Unsubscribe": `<mailto:${process.env.SMTP_FROM ?? "unsubscribe@example.com"}?subject=unsubscribe>`,
      },
    });
    providerMessageId = info.messageId ?? null;
  } else {
    console.log(
      `[dry-run] would send outreach ${item.id} to ${item.to_email ?? "unknown"}`,
    );
    providerMessageId = `dry-run:${item.id}`;
  }

  await pool.query("BEGIN");
  try {
    await pool.query(
      `UPDATE outreach_items
       SET hitl_status = 'sent', sent_at = now(), provider_message_id = $2, updated_at = now()
       WHERE id = $1`,
      [item.id, providerMessageId],
    );
    await pool.query(
      `UPDATE leads
       SET state = 'Contacted', last_contacted_at = now(), updated_at = now()
       WHERE id = $1 AND state = 'QueuedForApproval'`,
      [item.lead_id],
    );
    await pool.query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, 'QueuedForApproval', 'Contacted', 'dispatcher send after HITL approve', 'system:dispatcher')`,
      [item.lead_id],
    );
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }

  if (item.inbox_id) {
    const ymd = new Date().toISOString().slice(0, 10);
    const sentKey = redisKeys.inboxSent(item.inbox_id, ymd);
    await redis.incr(sentKey);
    await redis.expire(sentKey, 48 * 3600);
  }

  console.log(`sent ${item.id}`);
}

async function tick(
  pool: pg.Pool,
  redis: Redis,
  transport: nodemailer.Transporter | null,
): Promise<void> {
  const items = await loadDueItems(pool);
  if (!items.length) return;
  const approvedIds = await approvedCaseStudyIds(pool);
  for (const item of items) {
    try {
      await dispatchOne(pool, redis, transport, item, approvedIds);
    } catch (err) {
      console.error(`dispatch failed ${item.id}`, err);
    }
  }
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const transport = createTransport();
  console.log(
    `dispatcher started (smtp=${transport ? "on" : "dry-run"}, poll=${POLL_MS}ms)`,
  );

  const loop = async () => {
    try {
      await tick(pool, redis, transport);
    } catch (err) {
      console.error("tick error", err);
    }
  };

  await loop();
  setInterval(loop, POLL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
