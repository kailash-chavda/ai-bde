import { LeadIngestSchema, type LeadSource } from "@ai-bde/schemas";
import { ingestLead } from "@/lib/pipeline";
import { NextResponse } from "next/server";
import { z } from "zod";

const ImportSchema = z.object({
  source: z.enum(["csv", "sales_navigator"]).default("csv"),
  leads: z.array(LeadIngestSchema).min(1),
});

function parseCsv(text: string): unknown[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return {
      company: row.company ?? row.account ?? "",
      domain: row.domain ?? row.company_domain ?? "",
      geography: row.geography || undefined,
      decision_maker: {
        full_name: row.full_name ?? row.name ?? row.decision_maker ?? "",
        email: row.email || undefined,
        linkedin_url: row.linkedin_url || row.linkedin || undefined,
        role: row.role ?? row.title ?? "Unknown",
      },
      tech_hints: row.tech ? [row.tech] : undefined,
      hiring_hints: row.hiring ? [row.hiring] : undefined,
      notes: row.notes || undefined,
      external_id: row.external_id || row.id || undefined,
    };
  });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  try {
    let source: LeadSource = "csv";
    let leadsRaw: unknown[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const sourceField = String(form.get("source") ?? "csv");
      source = sourceField === "sales_navigator" ? "sales_navigator" : "csv";
      if (file && typeof file === "object" && "text" in file) {
        const text = await (file as File).text();
        if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
          const json = JSON.parse(text) as unknown;
          leadsRaw = Array.isArray(json)
            ? json
            : ((json as { leads?: unknown[] }).leads ?? []);
          source = "sales_navigator";
        } else {
          leadsRaw = parseCsv(text);
        }
      }
    } else {
      const body = await req.json();
      if (Array.isArray(body)) {
        leadsRaw = body;
      } else {
        const parsed = ImportSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: parsed.error.flatten() },
            { status: 400 },
          );
        }
        source = parsed.data.source;
        leadsRaw = parsed.data.leads;
      }
    }

    const results: Array<{
      leadId: string;
      deduped: boolean;
      state: string;
      error?: string;
    }> = [];

    for (const raw of leadsRaw) {
      const parsed = LeadIngestSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          leadId: "",
          deduped: false,
          state: "invalid",
          error: JSON.stringify(parsed.error.flatten()),
        });
        continue;
      }
      const out = await ingestLead({ ingest: parsed.data, source });
      results.push(out);
    }

    return NextResponse.json({ accepted: results.length, results }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 500 },
    );
  }
}
