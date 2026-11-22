import {
  runCopywriterAgentAsync,
  runResearchAgentAsync,
} from "@ai-bde/agents";
import { planTransition } from "@ai-bde/orchestrator";
import {
  normalizeDomain,
  type ApprovedCaseStudy,
  type LeadIngest,
  type LeadSource,
} from "@ai-bde/schemas";
import { createHash } from "node:crypto";
import { query } from "./db";

const DEFAULT_TEMPLATE_ID = "11111111-1111-1111-1111-111111111111";
const DEFAULT_INBOX_ID = "22222222-2222-2222-2222-222222222222";

export async function checkSuppression(input: {
  email?: string;
  domain: string;
  linkedinUrl?: string;
}): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM suppression_list
     WHERE ($1::citext IS NOT NULL AND email = $1::citext)
        OR domain = $2
        OR ($3::text IS NOT NULL AND linkedin_url = $3)
     LIMIT 1`,
    [input.email ?? null, input.domain, input.linkedinUrl ?? null],
  );
  return rows.length > 0;
}

async function loadApprovedCaseStudies(
  pillar: string | null,
): Promise<ApprovedCaseStudy[]> {
  const { rows } = await query<{
    id: string;
    slug: string;
    title: string;
    service_pillars: string[];
    industries: string[];
    tech_tags: string[];
    summary: string;
    outcomes: ApprovedCaseStudy["outcomes"];
    client_name: string | null;
    anonymized_label: string | null;
    source_url: string | null;
  }>(
    `SELECT id, slug, title, service_pillars::text[] AS service_pillars,
            industries, tech_tags, summary, outcomes, client_name,
            anonymized_label, source_url
     FROM case_studies
     WHERE approved = true AND archived_at IS NULL
       AND ($1::text IS NULL OR $1::service_pillar = ANY(service_pillars))
     ORDER BY updated_at DESC
     LIMIT 20`,
    [pillar],
  );

  return rows.map((r) => ({
    ...r,
    service_pillars: r.service_pillars as ApprovedCaseStudy["service_pillars"],
    approved: true as const,
  }));
}

export async function ingestLead(input: {
  ingest: LeadIngest;
  source: LeadSource;
  actor?: string;
}): Promise<{ leadId: string; deduped: boolean; state: string }> {
  const domain = normalizeDomain(input.ingest.domain);
  const externalId =
    input.ingest.external_id ??
    input.ingest.idempotency_key ??
    createHash("sha256")
      .update(
        `${input.source}|${domain}|${input.ingest.decision_maker.email ?? ""}|${input.ingest.decision_maker.full_name}`,
      )
      .digest("hex")
      .slice(0, 32);

  const existing = await query<{ id: string; state: string; profile: unknown }>(
    `SELECT id, state, profile FROM leads WHERE source = $1 AND external_id = $2`,
    [input.source, externalId],
  );
  if (existing.rows[0]) {
    return {
      leadId: existing.rows[0].id,
      deduped: true,
      state: existing.rows[0].state,
    };
  }

  const suppressed = await checkSuppression({
    email: input.ingest.decision_maker.email,
    domain,
    linkedinUrl:
      input.ingest.linkedin_url ?? input.ingest.decision_maker.linkedin_url,
  });

  await query("BEGIN");
  try {
    const insert = await query<{ id: string }>(
      `INSERT INTO leads (state, source, external_id, company, domain, decision_maker, geography, tier)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        suppressed ? "DoNotContact" : "New",
        input.source,
        externalId,
        input.ingest.company,
        domain,
        JSON.stringify(input.ingest.decision_maker),
        input.ingest.geography ?? null,
        input.ingest.tier_hint ?? null,
      ],
    );
    const leadId = insert.rows[0]!.id;

    if (suppressed) {
      await query(
        `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
         VALUES ($1, NULL, 'DoNotContact', 'suppression hit on ingest', $2)`,
        [leadId, input.actor ?? "system:ingest"],
      );
      await query("COMMIT");
      return { leadId, deduped: false, state: "DoNotContact" };
    }

    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, NULL, 'New', 'ingest', $2)`,
      [leadId, input.actor ?? "system:ingest"],
    );

    const research = await runResearchAgentAsync({
      ingest: { ...input.ingest, domain },
      sourceLabel: `ingest:${input.source}`,
    });

    await query(
      `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
       VALUES ($1, 'research', $2, $3::jsonb, $4, 'success')`,
      [
        leadId,
        createHash("sha256").update(JSON.stringify(input.ingest)).digest("hex"),
        JSON.stringify(research),
        research.model,
      ],
    );

    if (research.disqualify) {
      const t = planTransition({
        from: "New",
        to: "Disqualified",
        reason: research.disqualifyReason ?? "ICP fail",
        actor: "agent:research",
      });
      await query(
        `UPDATE leads SET state = $2, profile = $3::jsonb, confidence_score = $4,
          matched_pillar = $5, disqualify_reason = $6, updated_at = now()
         WHERE id = $1`,
        [
          leadId,
          t.to,
          JSON.stringify(research.profile),
          research.profile.confidence_score,
          research.profile.matched_service_pillar,
          research.disqualifyReason ?? null,
        ],
      );
      await query(
        `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [leadId, t.from, t.to, t.reason, t.actor],
      );
      await query("COMMIT");
      return { leadId, deduped: false, state: "Disqualified" };
    }

    const enriched = planTransition({
      from: "New",
      to: "Enriched",
      reason: "Research Agent complete",
      actor: "agent:research",
    });
    await query(
      `UPDATE leads SET state = $2, profile = $3::jsonb, confidence_score = $4,
        matched_pillar = $5, tier = COALESCE(tier, $6), updated_at = now()
       WHERE id = $1`,
      [
        leadId,
        enriched.to,
        JSON.stringify(research.profile),
        research.profile.confidence_score,
        research.profile.matched_service_pillar,
        research.profile.tier ?? null,
      ],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [leadId, enriched.from, enriched.to, enriched.reason, enriched.actor],
    );

    const approved = await loadApprovedCaseStudies(
      research.profile.matched_service_pillar,
    );
    const copy = await runCopywriterAgentAsync({
      leadId,
      profile: research.profile,
      approvedCaseStudies: approved,
      stepIndex: 1,
      requireUnsubscribe: true,
    });

    await query(
      `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
       VALUES ($1, 'copywriter', $2, $3::jsonb, $4, $5)`,
      [
        leadId,
        createHash("sha256")
          .update(JSON.stringify({ leadId, studies: approved.map((s) => s.id) }))
          .digest("hex"),
        JSON.stringify(copy),
        copy.model,
        copy.needsHuman && copy.reason?.includes("case_study")
          ? "failed"
          : "success",
      ],
    );

    // Portfolio integrity: do not queue drafts that cite unapproved IDs
    if (
      copy.draft.case_study_ids?.some(
        (id) => !approved.some((s) => s.id === id),
      )
    ) {
      await query("COMMIT");
      return { leadId, deduped: false, state: "Enriched" };
    }

    const seq = await query<{ id: string }>(
      `INSERT INTO lead_sequences (lead_id, template_id, status, current_step)
       VALUES ($1, $2, 'active', 1)
       RETURNING id`,
      [leadId, DEFAULT_TEMPLATE_ID],
    );

    await query(
      `INSERT INTO outreach_items (
         lead_id, sequence_id, step_index, channel, subject, body, char_count,
         matched_case_study_id, case_study_ids, hitl_status, requires_hitl,
         inbox_id, idempotency_key
       ) VALUES (
         $1, $2, $3, 'email', $4, $5, $6, $7, $8::uuid[], 'pending', true, $9, $10
       )`,
      [
        leadId,
        seq.rows[0]!.id,
        copy.draft.step_index ?? 1,
        copy.draft.subject,
        copy.draft.body,
        copy.draft.char_count,
        copy.draft.matched_case_study_id,
        copy.draft.case_study_ids ?? [],
        DEFAULT_INBOX_ID,
        copy.draft.idempotency_key,
      ],
    );

    const queued = planTransition({
      from: "Enriched",
      to: "QueuedForApproval",
      reason: "Copywriter drafted sequence step 1",
      actor: "agent:copywriter",
    });
    await query(
      `UPDATE leads SET state = $2, sequence_template_id = $3, updated_at = now() WHERE id = $1`,
      [leadId, queued.to, DEFAULT_TEMPLATE_ID],
    );
    await query(
      `INSERT INTO state_transitions (lead_id, from_state, to_state, reason, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [leadId, queued.from, queued.to, queued.reason, queued.actor],
    );

    await query("COMMIT");
    return { leadId, deduped: false, state: "QueuedForApproval" };
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }
}

/** Case study approve → embed stub (Phase 1 logs pending embedding). */
export async function approveCaseStudy(
  id: string,
  approvedBy?: string,
): Promise<{ id: string; embeddingStatus: string }> {
  const { rows } = await query<{ id: string; embedding_status: string }>(
    `UPDATE case_studies
     SET approved = true,
         approved_at = now(),
         approved_by = $2,
         embedding_status = 'pending',
         updated_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING id, embedding_status`,
    [id, approvedBy ?? null],
  );
  if (!rows[0]) throw new Error("Case study not found");

  // Stub embed pipeline — real vector write deferred until embedding provider configured
  await query(
    `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
     VALUES (NULL, 'embed_case_study', $1, $2::jsonb, $3, 'success')`,
    [
      createHash("sha256").update(id).digest("hex"),
      JSON.stringify({
        case_study_id: id,
        embedding_status: "pending",
        note: "Phase 1 stub: mark pending; wire OpenAI/pgvector write when EMBEDDING_PROVIDER != stub",
      }),
      process.env.EMBEDDING_PROVIDER ?? "stub",
    ],
  );

  if ((process.env.EMBEDDING_PROVIDER ?? "stub") === "stub") {
    await query(
      `UPDATE case_studies SET embedding_status = 'ready', updated_at = now() WHERE id = $1`,
      [id],
    );
    return { id, embeddingStatus: "ready" };
  }

  return { id, embeddingStatus: rows[0].embedding_status };
}
