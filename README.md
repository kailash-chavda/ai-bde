# AI BDE

Production-oriented **AI Business Development Executive** platform for a remote-first software agency.

**Phase 1**: lead ingest → research/ICP → email draft → **HITL approve/reject** → dispatcher send (dry-run without SMTP).  
**Phase 2 slice A**: adaptive **3–5 step email sequences**, Redis `seq:due` ZSET scheduler, pause on reply/booking/opt-out, Slack webhook alerts, dashboard pause/resume. LinkedIn and multi-inbox rotation are out of scope for this slice.

Postgres is the CRM. Zero invented clients/metrics; copywriter cites only `approved` case studies. Optional OpenAI-compatible LLM enhances research/copy with fail-closed grounding.

## Monorepo layout

```
apps/web/                 # Next.js HITL dashboard + API
packages/schemas/         # Zod / shared types
packages/orchestrator/    # State machine + send gates + sequence helpers
packages/agents/          # Research, Copywriter; Triage stub; CRM stub
workers/dispatcher/       # SMTP + Redis seq:due worker + step advance
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
npm run db:migrate   # applies supabase/migrations/*.sql (incl. 003 email sequences)
npm run seed:case-studies   # optional: approved portfolio case studies
npm run build
npm run dev:web
```

`db:migrate` reads `DATABASE_URL` from the environment or `.env` (default `postgresql://aibde:aibde@localhost:5432/aibde`). It must print `ok 001_initial.sql` … `ok 003_phase2_email_sequences.sql` and list `outreach_items` among tables.

### Seed portfolio case studies

Facts-only seed from [kailash-chavda.github.io/#projects](https://kailash-chavda.github.io/#projects) → `scripts/data/portfolio-case-studies.json`. Rows are inserted as **`approved=true`**. Idempotent on `slug`.

```bash
docker compose up -d
npm run db:migrate
npm run seed:case-studies
```

Optional dispatcher (dry-run logs sends when `SMTP_HOST` is unset; consumes Redis `seq:due` when present):

```bash
npm run dev:dispatcher
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | Postgres connection |
| `REDIS_URL` | for dispatcher / ZSET | Redis (`seq:due`, send locks, caps) |
| `WEBHOOK_API_KEY` | for webhook | `X-Api-Key` on `/api/leads/webhook` |
| `HITL_ACTOR` | no | Default HITL actor label |
| `SLACK_WEBHOOK_URL` | no | Incoming webhook for HITL approve + high-intent replies |
| `OPENAI_API_KEY` or `LLM_API_KEY` | no | Enables LLM research + copywriter |
| `OPENAI_BASE_URL` or `LLM_BASE_URL` | no | OpenAI-compatible base (default `https://api.openai.com/v1`) |
| `OPENAI_MODEL` or `LLM_MODEL` | no | Chat model (default `gpt-4o-mini`) |
| `SMTP_*` | no | Real SMTP; unset = dry-run dispatcher |
| `EMBEDDING_PROVIDER` | no | `stub` (default) until vectors are wired |
| `CAL_WEBHOOK_SECRET` | no | Cal.com webhook verification |
| `DISPATCHER_POLL_MS` | no | Dispatcher poll interval (default 5000) |

Copy `.env.example` → `.env` and fill what you need.

### Configure Slack alerts

1. In Slack: **Apps → Incoming Webhooks → Add to workspace** (or create via [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)).
2. Copy the webhook URL into `.env` as `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...`.
3. Restart `npm run dev:web`.
4. Alerts fire on:
   - **HITL approve** → item enqueued to `seq:due` / dispatcher
   - **High-intent inbound reply** stub (`interested_discovery_call`, portfolio, budget, referral)
   - Calendar booking and opt-out (best-effort)

Without `SLACK_WEBHOOK_URL`, alerts are logged as `[slack:skip]` and the rest of the flow still works.

## Try a 3-step email sequence locally

1. **Infra**: `docker compose up -d` · `npm run db:migrate` · `npm run seed:case-studies`
2. **Start**: `npm run build` · `npm run dev:web` and (second terminal) `npm run dev:dispatcher`
3. **Import** a lead (3-step template is default for non–Tier-1):

```bash
curl -s -X POST http://localhost:3000/api/leads/webhook \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: dev-webhook-key-change-me" \
  -d '{
    "idempotency_key": "seq-demo-1",
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

4. Open [http://localhost:3000](http://localhost:3000) → **Approve** step 1. Slack fires if configured; item is `ZADD`’d to `seq:due`.
5. Dispatcher dry-runs the send → lead `Contacted` → **auto-drafts step 2** (HITL pending). Approve step 2 (scheduled +3 business days from last send; for a quick local loop you can wait or set `scheduled_at` via SQL to `now()`).
6. After each send, the next step is drafted until the template completes (3 or 5 steps).
7. **Pause / resume** on `/leads/<id>` or:

```bash
# pause
curl -s -X POST http://localhost:3000/api/leads/<LEAD_ID>/sequence/pause \
  -H "Content-Type: application/json" -d '{}'

# resume (not allowed after calendar booking / opt-out)
curl -s -X POST http://localhost:3000/api/leads/<LEAD_ID>/sequence/resume \
  -H "Content-Type: application/json" -d '{}'
```

8. **Simulate a reply** (pauses sequence; high-intent → Slack):

```bash
curl -s -X POST http://localhost:3000/api/inbound/reply \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "<LEAD_ID>",
    "raw_body": "Interested — can we book a discovery call next week?"
  }'
```

9. **Opt-out** (cancel + suppression + `DoNotContact`):

```bash
curl -s -X POST http://localhost:3000/api/inbound/reply \
  -H "Content-Type: application/json" \
  -d '{ "lead_id": "<LEAD_ID>", "raw_body": "Please unsubscribe me" }'
```

10. **Cal.com booking stub** → `DiscoveryBooked` + sequence cancelled:

```bash
curl -s -X POST http://localhost:3000/api/webhooks/cal \
  -H "Content-Type: application/json" \
  -d '{
    "triggerEvent": "BOOKING_CREATED",
    "payload": {
      "uid": "demo-booking",
      "metadata": { "lead_id": "<LEAD_ID>" },
      "attendees": [{ "email": "alex@examplehealth.com" }]
    }
  }'
```

**Adaptive templates**: SMB / mid-market → 3-step (`11111111-…111`). `tier1_enterprise` → 5-step (`11111111-…112`). Pass `"tier_hint": "tier1_enterprise"` on ingest to exercise the 5-step path.

## Smoke path (Phase 1 still works)

1. Seed case studies · import lead · approve on HITL queue · run dispatcher → `Contacted`.
2. Dashboard CSV upload on `/leads` still supported.

### Enable LLM (optional)

1. Set `OPENAI_API_KEY` (or `LLM_API_KEY`) in `.env`.
2. Optionally set `OPENAI_BASE_URL` / `LLM_MODEL`.
3. Restart `npm run dev:web`.
4. Without a key, Research and Copywriter stay deterministic. **HITL remains required** on email sends in this slice.

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/leads/import` | CSV / SN JSON |
| `POST` | `/api/leads/webhook` | Website / Zapier (`X-Api-Key`) |
| `GET` | `/api/leads` | Filter leads |
| `GET` | `/api/leads/:id` | Detail + sequence + outreach |
| `POST` | `/api/leads/:id/transition` | Manual override |
| `POST` | `/api/leads/:id/sequence/pause` | Pause sequence + clear ZSET |
| `POST` | `/api/leads/:id/sequence/resume` | Resume (non-terminal pauses) |
| `GET` | `/api/hitl/queue` | Pending drafts |
| `POST` | `/api/hitl/:itemId/approve` | Approve → Redis `seq:due` + Slack |
| `POST` | `/api/hitl/:itemId/reject` | Reject → rewrite |
| `POST` | `/api/inbound/reply` | Reply/opt-out stub (pause / suppress) |
| `POST` | `/api/case-studies` | Create (unapproved) |
| `POST` | `/api/case-studies/:id/approve` | Approve → embed stub |
| `GET` | `/api/inboxes` | Inbox health |
| `POST` | `/api/crm/sync` | Postgres-only stub |
| `POST` | `/api/webhooks/cal` | Cal.com booking → pause sequence |
| `GET` | `/api/health` | DB + HITL depth |

## Grounding rules

- Never invent clients, metrics, or case studies.
- Portfolio mentions require a resolvable **approved** `case_study_id`.
- LLM drafts are validated server-side; violations **fail closed** to `deterministic-v1`.
- Phase 2 slice A: **HITL on email sends**; email channel only (no LinkedIn).
- Triage is a classification stub for pause + Slack; full auto-replies are Phase 3.

## Preferences locked

- CRM: Postgres-only  
- Workers: Node.js / TypeScript  
- Calendar: Cal.com  
- HITL on email sends; email-only outreach for this slice  

See the project technical spec for the full state machine and later Phase 2/3 scope (LinkedIn, multi-inbox).
