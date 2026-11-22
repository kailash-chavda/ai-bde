import { resumeLeadSequence } from "@/lib/sequences";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  actor: z.string().min(1).default("user:local-dev"),
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

  const result = await resumeLeadSequence({
    leadId: id,
    actor: parsed.data.actor,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
