import {
  classifyHiringSignals,
  enrichFromCompanyWebsite,
  isMobileOrFullstackSignal,
  normalizeJobBoardSignal,
  scoreDiscoverConfidence,
} from "@ai-bde/agents";
import {
  normalizeDomain,
  type DiscoverSourceKind,
  type JobBoardSignal,
} from "@ai-bde/schemas";
import type { Pool } from "pg";
import { createFetcher, type FetcherContext } from "./fetcher.js";

export interface IngestDiscoverOptions {
  sourceKind?: DiscoverSourceKind;
  fetcherCtx?: FetcherContext;
  /** Website enrichment fixture-only (default true) */
  fixtureOnlyWebsite?: boolean;
  /** Include non mobile/fullstack signals (default false) */
  includeAllRoles?: boolean;
}

export interface IngestDiscoverSummary {
  sourceKind: DiscoverSourceKind;
  fetched: number;
  upserted: number;
  skippedFilter: number;
  skipped?: string;
  candidateIds: string[];
}

/**
 * Fetch hiring signals → enrich website → upsert discover_candidates.
 * Idempotent on (source_kind, external_id).
 */
export async function runDiscoverIngest(
  pool: Pool,
  options: IngestDiscoverOptions = {},
): Promise<IngestDiscoverSummary> {
  const sourceKind = options.sourceKind ?? "fixture";
  const fetch = createFetcher(sourceKind);
  const result = await fetch(options.fetcherCtx);
  const includeAll = options.includeAllRoles ?? false;
  const fixtureOnlyWebsite = options.fixtureOnlyWebsite ?? true;

  let skippedFilter = 0;
  const candidateIds: string[] = [];
  let upserted = 0;

  for (const raw of result.signals) {
    const signal = normalizeJobBoardSignal(raw);
    const hiring = classifyHiringSignals({
      title: signal.job_title,
      description: signal.description,
      source: signal.source,
    });

    if (!includeAll && !isMobileOrFullstackSignal(hiring)) {
      skippedFilter += 1;
      continue;
    }

    const website = await enrichFromCompanyWebsite(signal.domain, {
      fixtureOnly: fixtureOnlyWebsite,
    });

    const techHints = [
      ...new Set(
        [...(signal.tech_hints ?? []), ...website.tech_hints].map((t) =>
          t.toLowerCase(),
        ),
      ),
    ];

    const hasPublicContact = Boolean(
      signal.decision_maker_hint?.email ||
        signal.decision_maker_hint?.linkedin_url,
    );

    const confidence = scoreDiscoverConfidence({
      hiring,
      techHints,
      websiteFetched: website.fetched,
      hasPublicContact,
    });

    const sources = [signal.source, ...website.sources];
    const domain = normalizeDomain(signal.domain);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO discover_candidates (
         external_id, source_kind, company, domain, job_title, job_url,
         location, geography, hiring_signals, tech_hints, sources,
         confidence_score, website_enrichment, decision_maker_hint,
         raw_payload, fetched_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10::text[], $11::jsonb,
         $12, $13::jsonb, $14::jsonb,
         $15::jsonb, now(), now()
       )
       ON CONFLICT (source_kind, external_id) DO UPDATE SET
         company = EXCLUDED.company,
         domain = EXCLUDED.domain,
         job_title = EXCLUDED.job_title,
         job_url = EXCLUDED.job_url,
         location = EXCLUDED.location,
         geography = EXCLUDED.geography,
         hiring_signals = EXCLUDED.hiring_signals,
         tech_hints = EXCLUDED.tech_hints,
         sources = EXCLUDED.sources,
         confidence_score = EXCLUDED.confidence_score,
         website_enrichment = EXCLUDED.website_enrichment,
         decision_maker_hint = COALESCE(EXCLUDED.decision_maker_hint, discover_candidates.decision_maker_hint),
         raw_payload = EXCLUDED.raw_payload,
         fetched_at = now(),
         updated_at = now(),
         -- Do not reopen promoted/dismissed
         status = discover_candidates.status
       WHERE discover_candidates.status = 'pending'
       RETURNING id`,
      [
        signal.external_id,
        sourceKind,
        signal.company,
        domain,
        signal.job_title,
        signal.job_url ?? null,
        signal.location ?? null,
        signal.geography ?? null,
        JSON.stringify([hiring]),
        techHints,
        JSON.stringify(sources),
        confidence,
        JSON.stringify(website),
        signal.decision_maker_hint
          ? JSON.stringify(signal.decision_maker_hint)
          : null,
        JSON.stringify(signal),
      ],
    );

    if (rows[0]) {
      upserted += 1;
      candidateIds.push(rows[0].id);
    }
  }

  return {
    sourceKind,
    fetched: result.signals.length,
    upserted,
    skippedFilter,
    skipped: result.skipped,
    candidateIds,
  };
}

/** Map a JobBoardSignal shape helper for tests */
export type { JobBoardSignal };
