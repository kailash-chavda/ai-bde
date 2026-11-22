import { promoteDiscoverCandidate } from "@/lib/discover";
import { DiscoverPromoteSchema } from "@ai-bde/schemas";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/discover/:id/promote — HITL still required for first send */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const json = await req.json();
    const body = DiscoverPromoteSchema.parse(json);
    const result = await promoteDiscoverCandidate({
      candidateId: id,
      body,
      actor: process.env.HITL_ACTOR ?? "user:local-dev",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Promote failed";
    const status =
      message.includes("not found") || message.includes("dismissed")
        ? 404
        : message.includes("requires decision_maker")
          ? 400
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
