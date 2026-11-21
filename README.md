# AI BDE

Production-oriented **AI Business Development Executive** platform for a remote-first software agency.

**Phase 1** (this branch): lead ingest → research/ICP → email draft → **HITL approve/reject** → dispatcher send (dry-run without SMTP). Postgres is the CRM. Zero invented clients/metrics; copywriter cites only `approved` case studies.

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
npm run db:migrate
npm run build
npm run dev:web
```

Optional dispatcher (dry-run logs sends when `SMTP_HOST` is unset):

```bash
npm run dev:dispatcher
```

Open [http://localhost:3000](http://localhost:3000).

## Smoke path

1. **Create + approve a case study** (dashboard `/case-studies` or API) so drafts can cite a real `case_study_id`.
2. **Import a lead**:

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

CSV / Sales Navigator:

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
- Phase 1: **HITL on all sends**; email channel only.
- Triage + external CRM are stubs until later phases.

## Preferences locked for Phase 1

- CRM: Postgres-only  
- Workers: Node.js / TypeScript  
- Calendar: Cal.com  
- HITL on all sends; email-only outreach  

See the project technical spec for full state machine and Phase 2/3 scope.
