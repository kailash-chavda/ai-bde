import { runDiscoverIngest } from "@ai-bde/ingest-discover/ingest";
import {
  DiscoverPromoteSchema,
  GeographySchema,
  type DiscoverPromote,
  type DiscoverSourceKind,
  type SourceRef,
  type WebsiteEnrichment,
} from "@ai-bde/schemas";
import { getPool, query } from "./db";
import { sendDiscordAlert } from "./discord";
import { ingestLead } from "./pipeline";

export interface DiscoverCandidateRow {
  id: string;
  external_id: string;
  source_kind: string;
  company: string;
  domain: string;
  job_title: string;
  job_url: string | null;
  location: string | null;
  geography: string | null;
  hiring_signals: unknown;
  tech_hints: string[];
  sources: SourceRef[];
  confidence_score: string;
  website_enrichment: WebsiteEnrichment | null;
  decision_maker_hint: {
    full_name?: string;
    role?: string;
    email?: string;
    linkedin_url?: string;
  } | null;
  status: string;
  promoted_lead_id: string | null;
  fetched_at: string;
  created_at: string;
}

export async function listDiscoverCandidates(status = "pending") {
  const { rows } = await query<DiscoverCandidateRow>(
    `SELECT id, external_id, source_kind, company, domain, job_title, job_url,
            location, geography, hiring_signals, tech_hints, sources,
            confidence_score::text, website_enrichment, decision_maker_hint,
            status::text, promoted_lead_id, fetched_at::text, created_at::text
     FROM discover_candidates
     WHERE ($1::text = 'all' OR status::text = $1)
     ORDER BY confidence_score DESC, fetched_at DESC
     LIMIT 100`,
    [status],
  );
  return rows;
}

export async function runDiscoverFetch(input?: {
  sourceKind?: DiscoverSourceKind;
}) {
  const pool = getPool();
  return runDiscoverIngest(pool, {
    sourceKind: input?.sourceKind ?? "fixture",
    fixtureOnlyWebsite: (process.env.DISCOVER_WEBSITE_HTTP ?? "0") !== "1",
  });
}

export async function promoteDiscoverCandidate(input: {
  candidateId: string;
  body: DiscoverPromote;
  actor?: string;
}): Promise<{
  leadId: string;
  state: string;
  deduped: boolean;
  candidateId: string;
}> {
  const parsed = DiscoverPromoteSchema.parse(input.body);

  // Never invent emails — require human-supplied contact path
  if (!parsed.decision_maker.email && !parsed.decision_maker.linkedin_url) {
    throw new Error(
      "Promote requires decision_maker.email or linkedin_url (do not invent contacts)",
    );
  }

  const { rows } = await query<DiscoverCandidateRow>(
    `SELECT id, external_id, source_kind, company, domain, job_title, job_url,
            location, geography, hiring_signals, tech_hints, sources,
            confidence_score::text, website_enrichment, decision_maker_hint,
            status::text, promoted_lead_id, fetched_at::text, created_at::text
     FROM discover_candidates WHERE id = $1`,
    [input.candidateId],
  );
  const candidate = rows[0];
  if (!candidate) throw new Error("Discover candidate not found");
  if (candidate.status === "promoted" && candidate.promoted_lead_id) {
    return {
      leadId: candidate.promoted_lead_id,
      state: "already_promoted",
      deduped: true,
      candidateId: candidate.id,
    };
  }
  if (candidate.status === "dismissed") {
    throw new Error("Candidate was dismissed");
  }

  const hiringTitles = Array.isArray(candidate.hiring_signals)
    ? (candidate.hiring_signals as Array<{ title?: string }>)
        .map((h) => h.title)
        .filter((t): t is string => Boolean(t))
    : [candidate.job_title];

  const geoParsed = GeographySchema.safeParse(
    parsed.geography ?? candidate.geography,
  );

  const result = await ingestLead({
    source: "job_board",
    actor: input.actor ?? "user:discover-promote",
    extraSources: candidate.sources,
    websiteEnrichment: candidate.website_enrichment,
    runWebsiteEnrichment: true,
    fixtureOnlyWebsite: (process.env.DISCOVER_WEBSITE_HTTP ?? "0") !== "1",
    ingest: {
      external_id: `discover:${candidate.source_kind}:${candidate.external_id}`,
      company: candidate.company,
      domain: candidate.domain,
      decision_maker: parsed.decision_maker,
      geography: geoParsed.success ? geoParsed.data : undefined,
      tier_hint: parsed.tier_hint,
      notes:
        parsed.notes ??
        `Promoted from Discover. Job: ${candidate.job_title}${candidate.job_url ? ` (${candidate.job_url})` : ""}`,
      message: `Hiring signal: ${candidate.job_title}`,
      tech_hints: candidate.tech_hints,
      hiring_hints: hiringTitles.length ? hiringTitles : [candidate.job_title],
    },
  });

  await query(
    `UPDATE discover_candidates
     SET status = 'promoted',
         promoted_lead_id = $2,
         updated_at = now()
     WHERE id = $1`,
    [candidate.id, result.leadId],
  );

  await sendDiscordAlert({
    kind: "discover_promoted",
    text: `Promoted ${candidate.company} → lead pipeline`,
    fields: {
      candidate_id: candidate.id,
      lead_id: result.leadId,
      state: result.state,
      job_title: candidate.job_title,
      confidence: candidate.confidence_score,
    },
  });

  return {
    leadId: result.leadId,
    state: result.state,
    deduped: result.deduped,
    candidateId: candidate.id,
  };
}

export async function dismissDiscoverCandidate(input: {
  candidateId: string;
  reason?: string;
}): Promise<{ ok: true }> {
  const { rows } = await query<{ id: string; status: string }>(
    `UPDATE discover_candidates
     SET status = 'dismissed',
         dismiss_reason = $2,
         updated_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, status::text`,
    [input.candidateId, input.reason ?? "dismissed_by_reviewer"],
  );
  if (!rows[0]) throw new Error("Candidate not found or not pending");
  return { ok: true };
}
