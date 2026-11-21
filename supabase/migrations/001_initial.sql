-- AI BDE Phase 1 schema (Postgres + pgvector)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE lead_state AS ENUM (
  'New','Enriched','QueuedForApproval','Contacted','Replied',
  'DiscoveryBooked','Disqualified','DoNotContact'
);
CREATE TYPE outreach_channel AS ENUM ('email','linkedin_connect','linkedin_dm');
CREATE TYPE hitl_status AS ENUM ('pending','approved','rejected','sent');
CREATE TYPE reply_classification AS ENUM (
  'interested_discovery_call','request_portfolio_case_study','rate_budget_inquiry',
  'objection_in_house_team','not_now','referral','unsubscribe','other','unclear'
);
CREATE TYPE service_pillar AS ENUM (
  'mobile_native','mobile_cross_platform','web_saas',
  'healthcare_medtech','ecommerce','erp'
);

CREATE TABLE case_studies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  title           text NOT NULL,
  service_pillars service_pillar[] NOT NULL,
  industries      text[] NOT NULL DEFAULT '{}',
  tech_tags       text[] NOT NULL DEFAULT '{}',
  summary         text NOT NULL,
  outcomes        jsonb NOT NULL DEFAULT '[]',
  client_name     text,
  anonymized_label text,
  approved        boolean NOT NULL DEFAULT false,
  approved_at     timestamptz,
  approved_by     uuid,
  embedding       vector(1536),
  embedding_status text NOT NULL DEFAULT 'none'
                  CHECK (embedding_status IN ('none','pending','ready','failed')),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_studies_outcomes_must_be_approved CHECK (
    approved = true OR outcomes = '[]'::jsonb
  )
);

CREATE INDEX case_studies_approved_idx ON case_studies (approved)
  WHERE approved = true AND archived_at IS NULL;

CREATE TABLE suppression_list (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext,
  domain       text,
  linkedin_url text,
  reason       text NOT NULL,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (email),
  UNIQUE NULLS NOT DISTINCT (linkedin_url)
);
CREATE INDEX suppression_domain_idx ON suppression_list (domain);

CREATE TABLE inboxes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE NOT NULL,
  display_name    text NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('google_workspace','m365','other_smtp')),
  smtp_host       text NOT NULL,
  imap_host       text NOT NULL,
  daily_send_cap  int NOT NULL DEFAULT 40,
  warmup_stage    int NOT NULL DEFAULT 0,
  timezone        text NOT NULL DEFAULT 'UTC',
  send_window_start time NOT NULL DEFAULT '09:00',
  send_window_end   time NOT NULL DEFAULT '17:00',
  spf_ok          boolean NOT NULL DEFAULT false,
  dkim_ok         boolean NOT NULL DEFAULT false,
  dmarc_ok        boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  pillar      service_pillar,
  steps       jsonb NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state             lead_state NOT NULL DEFAULT 'New',
  source            text NOT NULL,
  external_id       text,
  company           text NOT NULL,
  domain            text NOT NULL,
  decision_maker    jsonb NOT NULL,
  geography         text,
  tier              text,
  profile           jsonb,
  confidence_score  numeric(4,3),
  matched_pillar    service_pillar,
  sequence_template_id uuid REFERENCES sequence_templates(id),
  crm_external_id   text,
  crm_provider      text,
  disqualify_reason text,
  pause_reason      text,
  last_contacted_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX leads_state_idx ON leads (state);
CREATE INDEX leads_domain_idx ON leads (domain);

CREATE TABLE lead_sequences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES leads(id),
  template_id  uuid NOT NULL REFERENCES sequence_templates(id),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','completed','cancelled')),
  current_step int NOT NULL DEFAULT 1,
  paused_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outreach_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               uuid NOT NULL REFERENCES leads(id),
  sequence_id           uuid REFERENCES lead_sequences(id),
  step_index            int NOT NULL,
  channel               outreach_channel NOT NULL,
  subject               text,
  body                  text NOT NULL,
  char_count            int NOT NULL,
  matched_case_study_id uuid REFERENCES case_studies(id),
  case_study_ids        uuid[] NOT NULL DEFAULT '{}',
  hitl_status           hitl_status NOT NULL DEFAULT 'pending',
  requires_hitl         boolean NOT NULL DEFAULT true,
  inbox_id              uuid REFERENCES inboxes(id),
  scheduled_at          timestamptz,
  sent_at               timestamptz,
  provider_message_id   text,
  idempotency_key       text UNIQUE NOT NULL,
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_linkedin_no_subject CHECK (
    (channel = 'email' AND subject IS NOT NULL)
    OR (channel IN ('linkedin_connect','linkedin_dm') AND subject IS NULL)
  ),
  CONSTRAINT outreach_connect_char_range CHECK (
    channel <> 'linkedin_connect'
    OR (char_count BETWEEN 200 AND 300)
  )
);

CREATE TABLE inbound_events (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                    uuid NOT NULL REFERENCES leads(id),
  thread_id                  text NOT NULL,
  channel                    text NOT NULL,
  raw_message_id             text UNIQUE,
  raw_body                   text NOT NULL,
  classification             reply_classification,
  classification_confidence  numeric(4,3),
  urgency                    text,
  extracted_requirements     jsonb NOT NULL DEFAULT '[]',
  suggested_reply            text,
  suggested_reply_case_study_ids uuid[] DEFAULT '{}',
  suggested_reply_hitl_status hitl_status,
  escalate_to_human          boolean NOT NULL DEFAULT false,
  escalation_reason          text,
  received_at                timestamptz NOT NULL,
  processed_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid REFERENCES leads(id),
  direction       text NOT NULL CHECK (direction IN ('push','pull')),
  provider        text NOT NULL,
  operation       text NOT NULL,
  payload_hash    text NOT NULL,
  idempotency_key text UNIQUE NOT NULL,
  status          text NOT NULL CHECK (status IN ('success','failed','skipped')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE linkedin_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id),
  outreach_item_id uuid REFERENCES outreach_items(id),
  action_type     text NOT NULL CHECK (action_type IN ('connect','dm','profile_view')),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','executing','done','failed','cancelled')),
  scheduled_for   timestamptz NOT NULL,
  executed_at     timestamptz,
  error           text,
  idempotency_key text UNIQUE NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid REFERENCES leads(id),
  agent        text NOT NULL,
  input_hash   text NOT NULL,
  output       jsonb,
  model        text,
  tokens_in    int,
  tokens_out   int,
  status       text NOT NULL,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE state_transitions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid NOT NULL REFERENCES leads(id),
  from_state lead_state,
  to_state   lead_state NOT NULL,
  reason     text NOT NULL,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Seed: default email sequence template + low-cap inbox (inactive until SPF/DKIM/DMARC)
INSERT INTO sequence_templates (id, name, pillar, steps, active)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Phase 1 Email Step 1',
  NULL,
  '[{"step_index":1,"channel":"email","delay_business_days":0,"template_key":"cold_email_1","requires_hitl":true}]'::jsonb,
  true
);

INSERT INTO inboxes (
  id, email, display_name, provider, smtp_host, imap_host,
  daily_send_cap, spf_ok, dkim_ok, dmarc_ok, active
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'outreach@example.com',
  'BDE Outreach',
  'other_smtp',
  'smtp.example.com',
  'imap.example.com',
  20,
  false,
  false,
  false,
  false
);
