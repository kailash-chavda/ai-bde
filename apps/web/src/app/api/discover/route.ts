import { listDiscoverCandidates, runDiscoverFetch } from "@/lib/discover";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/discover?status=pending|promoted|dismissed|all */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "pending";
    const rows = await listDiscoverCandidates(status);
    return NextResponse.json({ candidates: rows });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to list candidates",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/discover — run ingest (default fixture fetcher).
 * Body: { source_kind?: "fixture"|"rss"|"job_board_api" }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      source_kind?: "fixture" | "rss" | "job_board_api";
    };
    const summary = await runDiscoverFetch({
      sourceKind: body.source_kind ?? "fixture",
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Discover ingest failed",
      },
      { status: 500 },
    );
  }
}
