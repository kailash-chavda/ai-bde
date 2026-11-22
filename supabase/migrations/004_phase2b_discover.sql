-- Phase 2B: Lead Discovery queue (job-board / RSS hiring signals).
-- Candidates are reviewed in the dashboard before promote → lead pipeline.
-- No LinkedIn scrape; emails are never invented by the system.

CREATE TYPE discover_status AS ENUM ('pending', 'promoted', 'dismissed');

CREATE TABLE discover_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id          text NOT NULL,
  source_kind          text NOT NULL
                       CHECK (source_kind IN ('fixture', 'rss', 'job_board_api')),
  company              text NOT NULL,
  domain               text NOT NULL,
  job_title            text NOT NULL,
  job_url              text,
  location             text,
  geography            text,
  hiring_signals       jsonb NOT NULL DEFAULT '[]',
  tech_hints           text[] NOT NULL DEFAULT '{}',
  sources              jsonb NOT NULL DEFAULT '[]',
  confidence_score     numeric(4,3) NOT NULL
                       CHECK (confidence_score >= 0 AND confidence_score <= 1),
  website_enrichment   jsonb,
  decision_maker_hint  jsonb,
  status               discover_status NOT NULL DEFAULT 'pending',
  promoted_lead_id     uuid REFERENCES leads(id),
  dismiss_reason       text,
  raw_payload          jsonb,
  fetched_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, external_id)
);

CREATE INDEX discover_candidates_status_idx ON discover_candidates (status, fetched_at DESC);
CREATE INDEX discover_candidates_domain_idx ON discover_candidates (domain);
