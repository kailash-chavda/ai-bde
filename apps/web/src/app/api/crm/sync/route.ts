import { runCrmSyncStub } from "@ai-bde/agents";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";

const BodySchema = z.object({
  leadId: z.string().uuid(),
  direction: z.enum(["push", "pull"]).default("push"),
});

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const stub = runCrmSyncStub({
    leadId: parsed.data.leadId,
    direction: parsed.data.direction,
    provider: "postgres_only",
  });

  const key = `crm:${parsed.data.direction}:${parsed.data.leadId}:${Date.now()}`;
  await query(
    `INSERT INTO crm_sync_log (
       lead_id, direction, provider, operation, payload_hash, idempotency_key, status, error
     ) VALUES ($1, $2, 'postgres_only', 'stub', $3, $4, 'skipped', $5)`,
    [
      parsed.data.leadId,
      parsed.data.direction,
      createHash("sha256").update(key).digest("hex"),
      key,
      stub.message,
    ],
  );

  return NextResponse.json(stub);
}
