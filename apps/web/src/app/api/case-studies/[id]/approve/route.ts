import { approveCaseStudy } from "@/lib/pipeline";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  outcomes: z
    .array(
      z.object({
        metric: z.string().min(1),
        value: z.string().min(1),
        verified: z.literal(true),
      }),
    )
    .optional(),
  approvedBy: z.string().uuid().optional(),
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

  try {
    if (parsed.data.outcomes?.length) {
      // Only verified outcomes may be attached at approve time
      await query(
        `UPDATE case_studies SET outcomes = $2::jsonb, updated_at = now() WHERE id = $1 AND approved = false`,
        [id, JSON.stringify(parsed.data.outcomes)],
      );
    }
    const result = await approveCaseStudy(id, parsed.data.approvedBy);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approve failed" },
      { status: 400 },
    );
  }
}
