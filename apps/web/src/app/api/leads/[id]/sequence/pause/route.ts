import { SEQUENCE_PAUSE_REASONS } from "@ai-bde/orchestrator";
import { pauseLeadSequence } from "@/lib/sequences";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  actor: z.string().min(1).default("user:local-dev"),
  reason: z.string().min(1).default(SEQUENCE_PAUSE_REASONS.manual),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await pauseLeadSequence({
    leadId: id,
    reason: parsed.data.reason,
    actor: parsed.data.actor,
    cancel: false,
  });

  return NextResponse.json(result);
}
