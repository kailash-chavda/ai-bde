# AI BDE

Production-oriented **AI Business Development Executive** platform for a remote-first software agency.

**Phase 1**: lead ingest → research/ICP → email draft → **HITL approve/reject** → dispatcher send (dry-run without SMTP). Postgres is the CRM. Zero invented clients/metrics; copywriter cites only `approved` case studies. Optional OpenAI-compatible LLM enhances research/copy with fail-closed grounding.

## Monorepo layout

```
apps/web/                 # Next.js HITL dashboard + API
packages/schemas/         # Zod / shared types
packages/orchestrator/    # State machine + send gates
packages/agents/          # Research, Copywriter; Triage/CRM stubs
workers/dispatcher/       # SMTP + Redis send worker
supabase/migrations/      # Postgres + pgvector DDL
```

## Prerequisites

- Node.js ≥ 20
- Docker (Postgres + Redis)

## Local setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate   # applies supabase/migrations/*.sql (creates outreach_items, etc.)
npm run seed:case-studies   # optional: approved portfolio case studies
npm run build
npm run dev:web
```

`db:migrate` reads `DATABASE_URL` from the environment or `.env` (default `postgresql://aibde:aibde@localhost:5432/aibde`). It must print `ok 001_initial.sql` (and `ok 002_case_study_source_url.sql` on first run) and list `outreach_items` among tables. If an earlier failed run left an empty `schema_migrations` row bookkeeping table only, re-run `npm run db:migrate` after pulling this fix.

### Seed portfolio case studies

Facts-only seed from [kailash-chavda.github.io/#projects](https://kailash-chavda.github.io/#projects) → `scripts/data/portfolio-case-studies.json`. Rows are inserted as **`approved=true`** with `source_url`, portfolio download/rating outcomes only where stated on the page, `client_name=null`, and a Phase 1 embed stub (`embedding_status=ready` when `EMBEDDING_PROVIDER=stub`). Idempotent on `slug`.

```bash
docker compose up -d          # local Docker Postgres on :5432
npm run db:migrate            # includes source_url column
npm run seed:case-studies     # upserts approved case studies
```

Skipped from seed (unpublished on the portfolio page): Aio, CityPlus, GShort, Daily Task. No ecommerce/ERP mappings — none of the curated projects fit those pillars on the source page.

Optional dispatcher (dry-run logs sends when `SMTP_HOST` is unset):

```bash
npm run dev:dispatcher
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | Postgres connection |
| `REDIS_URL` | for dispatcher | Redis |
| `WEBHOOK_API_KEY` | for webhook | `X-Api-Key` on `/api/leads/webhook` |
| `HITL_ACTOR` | no | Default HITL actor label |
| `OPENAI_API_KEY` or `LLM_API_KEY` | no | Enables LLM research + copywriter |
| `OPENAI_BASE_URL` or `LLM_BASE_URL` | no | OpenAI-compatible base (default `https://api.openai.com/v1`) |
| `OPENAI_MODEL` or `LLM_MODEL` | no | Chat model (default `gpt-4o-mini`) |
| `SMTP_*` | no | Real SMTP; unset = dry-run dispatcher |
| `EMBEDDING_PROVIDER` | no | `stub` (default) until vectors are wired |
| `CAL_WEBHOOK_SECRET` | no | Cal.com webhook verification |

Copy `.env.example` → `.env` and fill what you need.

### Enable LLM (optional)

1. Set `OPENAI_API_KEY` (or `LLM_API_KEY`) in `.env`.
2. Optionally set `OPENAI_BASE_URL` / `LLM_BASE_URL` for a compatible proxy, and `OPENAI_MODEL` / `LLM_MODEL`.
3. Restart `npm run dev:web`.
4. Import a lead — `agent_runs.model` will show the LLM model when grounding passes, or `deterministic-v1` with `llmFallbackReason` when the model invents clients/metrics or cites unknown `case_study_id`s.

Without a key, Research and Copywriter stay fully deterministic. **HITL remains required before every send** either way.

## Smoke path

1. **Case studies**: run `npm run seed:case-studies`, or create + approve on `/case-studies` / API, so drafts can cite a real `case_study_id`.
2. **Import a lead** (dashboard or API):

### Dashboard CSV upload

1. Open [http://localhost:3000/leads](http://localhost:3000/leads).
2. Under **Import CSV**, choose source (`csv` or `sales_navigator`) and pick a `.csv` file.
3. Click **Upload & ingest** — the page shows accepted/error rows and refreshes the leads table.

Example CSV:

```csv
company,domain,decision_maker,email,role,geography,tech,message
Acme Health,acme.example,Alex Chen,alex@acme.example,CTO,US,React Native,Need HIPAA-ready patient app
```

### API import

Import a lead via API:

```bash
curl -s -X POST http://localhost:3000/api/leads/webhook \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: dev-webhook-key-change-me" \
  -d '{
    "idempotency_key": "demo-1",
    "company": "Example Health",
    "domain": "examplehealth.com",
    "geography": "US",
    "decision_maker": {
      "full_name": "Alex Riv",
      "email": "alex@examplehealth.com",
      "role": "CTO"
    },
    "message": "Need HIPAA-ready patient app on React Native"
  }'
```

3. **Approve** the draft on the HITL queue (home page).
4. Run the dispatcher to mark send (dry-run) and transition lead → `Contacted`.

CSV / Sales Navigator JSON — flat `rows` or nested `leads`:

```bash
curl -s -X POST http://localhost:3000/api/leads/import \
  -H "Content-Type: application/json" \
  -d '{
    "source": "csv",
    "rows": [{
      "company": "Acme Health",
      "domain": "acme.example",
      "decision_maker": "Alex Chen",
      "role": "CTO",
      "geography": "US",
      "email": "alex@acme.example"
    }]
  }'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/leads/import -ContentType 'application/json' -Body '{"source":"csv","rows":[{"company":"Acme Health","domain":"acme.example","decision_maker":"Alex Chen","role":"CTO","geography":"US","email":"alex@acme.example"}]}'
```

Nested `leads` (same endpoint) still works:

```bash
curl -s -X POST http://localhost:3000/api/leads/import \
  -H "Content-Type: application/json" \
  -d '{
    "source": "csv",
    "leads": [{
      "company": "Acme SaaS",
      "domain": "acmesaas.io",
      "decision_maker": { "full_name": "Sam Lee", "email": "sam@acmesaas.io", "role": "VP Engineering" },
      "tech_hints": ["Next.js", "Node"],
      "notes": "Looking for SaaS full-stack help"
    }]
  }'
```

## API surface (Phase 1)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/leads/import` | CSV / SN JSON |
| `POST` | `/api/leads/webhook` | Website / Zapier (`X-Api-Key`) |
| `GET` | `/api/leads` | Filter leads |
| `GET` | `/api/leads/:id` | Detail |
| `POST` | `/api/leads/:id/transition` | Manual override |
| `GET` | `/api/hitl/queue` | Pending drafts |
| `POST` | `/api/hitl/:itemId/approve` | Approve → dispatcher |
| `POST` | `/api/hitl/:itemId/reject` | Reject → rewrite |
| `POST` | `/api/case-studies` | Create (unapproved) |
| `POST` | `/api/case-studies/:id/approve` | Approve → embed stub |
| `GET` | `/api/inboxes` | Inbox health |
| `POST` | `/api/crm/sync` | Postgres-only stub |
| `POST` | `/api/webhooks/cal` | Cal.com booking |
| `GET` | `/api/health` | DB + HITL depth |

## Grounding rules

- Never invent clients, metrics, or case studies.
- Portfolio mentions require a resolvable **approved** `case_study_id`.
- LLM drafts are validated server-side; violations **fail closed** to `deterministic-v1`.
- Phase 1: **HITL on all sends**; email channel only.
- Triage + external CRM are stubs until later phases.

## Preferences locked for Phase 1

- CRM: Postgres-only  
- Workers: Node.js / TypeScript  
- Calendar: Cal.com  
- HITL on all sends; email-only outreach  

See the project technical spec for full state machine and Phase 2/3 scope.
