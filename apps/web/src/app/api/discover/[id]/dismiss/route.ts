import { dismissDiscoverCandidate } from "@/lib/discover";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const json = (await req.json().catch(() => ({}))) as { reason?: string };
    await dismissDiscoverCandidate({
      candidateId: id,
      reason: json.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dismiss failed" },
      { status: 400 },
    );
  }
}
