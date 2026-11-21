/**
 * Phase 1 CRM stub — Postgres is system of record.
 * External CRM push/pull deferred to Phase 2.
 */
export interface CrmSyncRequest {
  leadId: string;
  direction: "push" | "pull";
  provider: "postgres_only";
}

export interface CrmSyncResult {
  status: "skipped";
  message: string;
}

export function runCrmSyncStub(req: CrmSyncRequest): CrmSyncResult {
  return {
    status: "skipped",
    message: `CRM sync stub: Postgres-only Phase 1; external ${req.direction} for lead ${req.leadId} deferred to Phase 2`,
  };
}
