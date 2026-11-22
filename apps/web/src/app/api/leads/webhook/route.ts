import { LeadIngestSchema } from "@ai-bde/schemas";
import { ingestLead } from "@/lib/pipeline";
import { NextResponse } from "next/server";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  const expected = process.env.WEBHOOK_API_KEY ?? "dev-webhook-key-change-me";
  if (!apiKey || apiKey !== expected) return unauthorized();

  try {
    const body = await req.json();
    const parsed = LeadIngestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const source =
      body?.utm?.source === "site" ? "website_form" : "webhook";

    const result = await ingestLead({
      ingest: parsed.data,
      source,
      actor: "system:webhook",
    });

    return NextResponse.json(result, {
      status: result.deduped ? 200 : 202,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Webhook failed" },
      { status: 500 },
    );
  }
}
