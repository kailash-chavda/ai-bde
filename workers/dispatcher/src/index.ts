import {
  runCopywriterAgentAsync,
  type PriorTouch,
} from "@ai-bde/agents";
import {
  evaluateDispatchGates,
  getNextEmailStep,
  parseSequenceSteps,
  planTransition,
  redisKeys,
} from "@ai-bde/orchestrator";
import type {
  AgencyLeadProfile,
  ApprovedCaseStudy,
  LeadState,
} from "@ai-bde/schemas";
import { createHash } from "node:crypto";
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
  sequence_id: string | null;
  step_index: number;
  subject: string | null;
  body: string;
  hitl_status: "pending" | "approved" | "rejected" | "sent";
  requires_hitl: boolean;
  case_study_ids: string[];
  inbox_id: string | null;
  idempotency_key: string;
  pause_reason: string | null;
  lead_state: LeadState;
  to_email: string | null;
}

async function loadDueFromRedis(
  pool: pg.Pool,
  redis: Redis,
): Promise<DueItem[]> {
  const now = Date.now();
  const ids = await redis.zrangebyscore(redisKeys.seqDue, 0, now, "LIMIT", 0, 20);
  if (!ids.length) return [];

  const { rows } = await pool.query<DueItem>(
    `SELECT o.id, o.lead_id, o.sequence_id, o.step_index, o.subject, o.body,
            o.hitl_status, o.requires_hitl, o.case_study_ids, o.inbox_id,
            o.idempotency_key, l.pause_reason,
            l.state::text AS lead_state,
            l.decision_maker->>'email' AS to_email
     FROM outreach_items o
     JOIN leads l ON l.id = o.lead_id
     WHERE o.id = ANY($1::uuid[])
       AND o.channel = 'email'
       AND o.hitl_status = 'approved'
       AND o.sent_at IS NULL
       AND l.pause_reason IS NULL
       AND l.state IN ('QueuedForApproval', 'Contacted')`,
    [ids],
  );

  // Drop stale ZSET members that are no longer dispatchable
  const found = new Set(rows.map((r) => r.id));
  const stale = ids.filter((id) => !found.has(id));
  if (stale.length) await redis.zrem(redisKeys.seqDue, ...stale);

  return rows;
}

async function loadDueFromPostgres(pool: pg.Pool): Promise<DueItem[]> {
  const { rows } = await pool.query<DueItem>(`
    SELECT o.id, o.lead_id, o.sequence_id, o.step_index, o.subject, o.body,
           o.hitl_status, o.requires_hitl, o.case_study_ids, o.inbox_id,
           o.idempotency_key, l.pause_reason,
           l.state::text AS lead_state,
           l.decision_maker->>'email' AS to_email
    FROM outreach_items o
    JOIN leads l ON l.id = o.lead_id
    WHERE o.channel = 'email'
      AND o.hitl_status = 'approved'
      AND o.sent_at IS NULL
      AND (o.scheduled_at IS NULL OR o.scheduled_at <= now())
      AND l.pause_reason IS NULL
      AND l.state IN ('QueuedForApproval', 'Contacted')
    ORDER BY o.scheduled_at ASC NULLS FIRST, o.created_at ASC
    LIMIT 20
  `);
  return rows;
}

async function loadDueItems(pool: pg.Pool, redis: Redis): Promise<DueItem[]> {
  try {
    const fromRedis = await loadDueFromRedis(pool, redis);
    if (fromRedis.length) return fromRedis;
  } catch (err) {
    console.error("redis seq:due read failed; falling back to Postgres", err);
  }
  return loadDueFromPostgres(pool);
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

async function loadApprovedStudies(
  pool: pg.Pool,
  pillar: string | null,
): Promise<ApprovedCaseStudy[]> {
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    title: string;
    service_pillars: ApprovedCaseStudy["service_pillars"];
    industries: string[];
    tech_tags: string[];
    summary: string;
    outcomes: ApprovedCaseStudy["outcomes"];
    client_name: string | null;
    anonymized_label: string | null;
  }>(
    `SELECT id, slug, title, service_pillars, industries, tech_tags, summary,
            outcomes, client_name, anonymized_label
     FROM case_studies
     WHERE approved = true AND archived_at IS NULL
       AND ($1::text IS NULL OR $1::service_pillar = ANY(service_pillars))
     ORDER BY updated_at DESC
     LIMIT 20`,
    [pillar],
  );
  return rows.map((r) => ({ ...r, approved: true as const }));
}

/** After HITL-approved send/dry-run: draft next email step or complete sequence. */
async function advanceSequenceAfterSend(
  pool: pg.Pool,
  item: DueItem,
): Promise<void> {
  if (!item.sequence_id) return;

  const seq = await pool.query<{
    id: string;
    status: string;
    current_step: number;
    steps: unknown;
  }>(
    `SELECT ls.id, ls.status, ls.current_step, st.steps
     FROM lead_sequences ls
     JOIN sequence_templates st ON st.id = ls.template_id
     WHERE ls.id = $1`,
    [item.sequence_id],
  );
  const row = seq.rows[0];
  if (!row || row.status !== "active") return;

  const steps = parseSequenceSteps(row.steps);
  const next = getNextEmailStep(steps, item.step_index);

  if (!next) {
    await pool.query(
      `UPDATE lead_sequences SET status = 'completed', current_step = $2
       WHERE id = $1`,
      [item.sequence_id, item.step_index],
    );
    console.log(`sequence ${item.sequence_id} completed after step ${item.step_index}`);
    return;
  }

  const lead = await pool.query<{
    profile: AgencyLeadProfile;
    matched_pillar: string | null;
    pause_reason: string | null;
    state: string;
  }>(
    `SELECT profile, matched_pillar::text AS matched_pillar, pause_reason, state::text AS state
     FROM leads WHERE id = $1`,
    [item.lead_id],
  );
  const leadRow = lead.rows[0];
  if (!leadRow?.profile || leadRow.pause_reason) return;
  if (leadRow.state !== "Contacted") return;

  const prior = await pool.query<{
    step_index: number;
    subject: string | null;
    body: string;
    sent_at: Date | null;
  }>(
    `SELECT step_index, subject, body, sent_at FROM outreach_items
     WHERE lead_id = $1 AND hitl_status = 'sent'
     ORDER BY step_index`,
    [item.lead_id],
  );
  const priorTouches: PriorTouch[] = prior.rows.map((p) => ({
    step_index: p.step_index,
    subject: p.subject,
    body: p.body,
    sent_at: p.sent_at ? new Date(p.sent_at).toISOString() : null,
  }));

  const approved = await loadApprovedStudies(pool, leadRow.matched_pillar);
  const copy = await runCopywriterAgentAsync({
    leadId: item.lead_id,
    profile: leadRow.profile,
    approvedCaseStudies: approved,
    stepIndex: next.step_index,
    templateKey: next.template_key,
    priorTouches,
    requireUnsubscribe: true,
  });

  const existing = await pool.query(
    `SELECT 1 FROM outreach_items WHERE idempotency_key = $1`,
    [copy.draft.idempotency_key],
  );
  if (existing.rows[0]) {
    console.log(`next step already drafted ${copy.draft.idempotency_key}`);
    return;
  }

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO outreach_items (
         lead_id, sequence_id, step_index, channel, subject, body, char_count,
         matched_case_study_id, case_study_ids, hitl_status, requires_hitl,
         inbox_id, idempotency_key
       ) VALUES (
         $1, $2, $3, 'email', $4, $5, $6, $7, $8::uuid[], 'pending', true, $9, $10
       )`,
      [
        item.lead_id,
        item.sequence_id,
        next.step_index,
        copy.draft.subject,
        copy.draft.body,
        copy.draft.char_count,
        copy.draft.matched_case_study_id,
        copy.draft.case_study_ids ?? [],
        item.inbox_id,
        copy.draft.idempotency_key,
      ],
    );
    await pool.query(
      `UPDATE lead_sequences SET current_step = $2 WHERE id = $1`,
      [item.sequence_id, next.step_index],
    );

    const t = planTransition({
      from: "Contacted",
      to: "QueuedForApproval",
      reason: `Copywriter drafted sequence step ${next.step_index}`,
      actor: "agent:copywriter",
    });
    await pool.query(
      `UPDATE leads SET state = $2, updated_at = now() WHERE id = $1 AND state = 'Contacted'`,
      [item.lead_id, t.to],
    );
    await pool.query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [item.lead_id, t.from, t.to, t.reason, t.actor],
    );
    await pool.query(
      `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
       VALUES ($1, 'copywriter', $2, $3::jsonb, $4, 'success')`,
      [
        item.lead_id,
        createHash("sha256")
          .update(
            copy.draft.idempotency_key ??
              `${item.lead_id}:email:step:${next.step_index}`,
          )
          .digest("hex"),
        JSON.stringify(copy),
        copy.model,
      ],
    );
    await pool.query("COMMIT");
    console.log(
      `advanced sequence ${item.sequence_id} → step ${next.step_index} pending HITL`,
    );
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
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

  const leadLock = redisKeys.lockLead(item.lead_id);
  const leadLocked = await redis.set(leadLock, "1", "EX", 60, "NX");
  if (leadLocked !== "OK") {
    console.log(`skip lead locked ${item.lead_id}`);
    await redis.del(lockKey);
    return;
  }

  try {
    const leadRes = await pool.query<{ domain: string }>(
      `SELECT domain FROM leads WHERE id = $1`,
      [item.lead_id],
    );
    const domain = leadRes.rows[0]?.domain ?? "";
    const suppressed = await isSuppressed(pool, item.to_email, domain);

    let inboxActive = true;
    let dailyCapRemaining = 40;
    const withinSendWindow = true;

    if (item.inbox_id) {
      const inbox = await pool.query<{
        active: boolean;
        daily_send_cap: number;
        spf_ok: boolean;
        dkim_ok: boolean;
        dmarc_ok: boolean;
      }>(
        `SELECT active, daily_send_cap, spf_ok, dkim_ok, dmarc_ok FROM inboxes WHERE id = $1`,
        [item.inbox_id],
      );
      const row = inbox.rows[0];
      inboxActive = Boolean(
        row?.active && row.spf_ok && row.dkim_ok && row.dmarc_ok,
      );
      const ymd = new Date().toISOString().slice(0, 10);
      const sentKey = redisKeys.inboxSent(item.inbox_id, ymd);
      const sent = Number((await redis.get(sentKey)) ?? "0");
      dailyCapRemaining = (row?.daily_send_cap ?? 40) - sent;
    } else if (!process.env.SMTP_HOST) {
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
        `[dry-run] would send outreach ${item.id} step ${item.step_index} to ${item.to_email ?? "unknown"}`,
      );
      providerMessageId = `dry-run:${item.id}`;
    }

    const fromState = item.lead_state;
    const toState: LeadState = "Contacted";

    await pool.query("BEGIN");
    try {
      await pool.query(
        `UPDATE outreach_items
         SET hitl_status = 'sent', sent_at = now(), provider_message_id = $2, updated_at = now()
         WHERE id = $1`,
        [item.id, providerMessageId],
      );

      if (fromState === "QueuedForApproval") {
        const t = planTransition({
          from: "QueuedForApproval",
          to: "Contacted",
          reason: `dispatcher send step ${item.step_index} after HITL approve`,
          actor: "system:dispatcher",
        });
        await pool.query(
          `UPDATE leads
           SET state = $2, last_contacted_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'QueuedForApproval'`,
          [item.lead_id, t.to],
        );
        await pool.query(
          `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
           VALUES ($1, $2, $3, $4, $5)`,
          [item.lead_id, t.from, t.to, t.reason, t.actor],
        );
      } else if (fromState === "Contacted") {
        await pool.query(
          `UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE id = $1`,
          [item.lead_id],
        );
        await pool.query(
          `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
           VALUES ($1, 'Contacted', 'Contacted', $2, 'system:dispatcher')`,
          [
            item.lead_id,
            `dispatcher send sequence step ${item.step_index}`,
          ],
        );
      }

      await pool.query(
        `UPDATE lead_sequences SET current_step = GREATEST(current_step, $2)
         WHERE id = $1`,
        [item.sequence_id, item.step_index],
      );
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    await redis.zrem(redisKeys.seqDue, item.id);

    if (item.inbox_id) {
      const ymd = new Date().toISOString().slice(0, 10);
      const sentKey = redisKeys.inboxSent(item.inbox_id, ymd);
      await redis.incr(sentKey);
      await redis.expire(sentKey, 48 * 3600);
    }

    console.log(`sent ${item.id} step ${item.step_index}`);

    // Refresh lead_state for advance (now Contacted)
    try {
      await advanceSequenceAfterSend(pool, {
        ...item,
        lead_state: toState,
      });
    } catch (err) {
      console.error(`advance failed after ${item.id}`, err);
    }
  } finally {
    await redis.del(leadLock);
  }
}

async function tick(
  pool: pg.Pool,
  redis: Redis,
  transport: nodemailer.Transporter | null,
): Promise<void> {
  const items = await loadDueItems(pool, redis);
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
    `dispatcher started (smtp=${transport ? "on" : "dry-run"}, poll=${POLL_MS}ms, seq:due ZSET)`,
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
