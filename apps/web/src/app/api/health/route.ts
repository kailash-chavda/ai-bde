import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  let db: "ok" | "error" = "error";
  let dbError: string | undefined;
  try {
    await query("SELECT 1");
    db = "ok";
  } catch (err) {
    dbError = err instanceof Error ? err.message : "unknown";
  }

  let queueDepth = 0;
  if (db === "ok") {
    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outreach_items WHERE hitl_status = 'pending'`,
    );
    queueDepth = Number(rows[0]?.count ?? 0);
  }

  return NextResponse.json({
    ok: db === "ok",
    db,
    dbError,
    redis: "not_checked_in_web",
    hitlQueueDepth: queueDepth,
    phase: 1,
  });
}
