import { LeadIngestSchema, type LeadSource } from "@ai-bde/schemas";
import { ingestLead } from "@/lib/pipeline";
import { NextResponse } from "next/server";
import { z } from "zod";

/** Envelope accepts either nested `leads` or flat CSV-style `rows`. */
const ImportSchema = z
  .object({
    source: z.enum(["csv", "sales_navigator"]).default("csv"),
    leads: z.array(z.unknown()).min(1).optional(),
    rows: z.array(z.unknown()).min(1).optional(),
  })
  .refine((d) => (d.leads?.length ?? 0) > 0 || (d.rows?.length ?? 0) > 0, {
    message: "Provide a non-empty leads or rows array",
  });

/**
 * Map flat CSV/SN-style objects (decision_maker as name string; email/role
 * at top level) into LeadIngest shape. Nested decision_maker objects pass through.
 */
function normalizeIngestRow(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;

  if (row.decision_maker && typeof row.decision_maker === "object") {
    return row;
  }

  const name =
    (typeof row.decision_maker === "string" ? row.decision_maker : "") ||
    (typeof row.full_name === "string" ? row.full_name : "") ||
    (typeof row.name === "string" ? row.name : "");
  const email = typeof row.email === "string" && row.email ? row.email : undefined;
  const role =
    (typeof row.role === "string" && row.role ? row.role : undefined) ||
    (typeof row.title === "string" && row.title ? row.title : undefined) ||
    "Unknown";
  const linkedin =
    (typeof row.linkedin_url === "string" && row.linkedin_url
      ? row.linkedin_url
      : undefined) ||
    (typeof row.linkedin === "string" && row.linkedin ? row.linkedin : undefined);

  return {
    idempotency_key: row.idempotency_key,
    external_id: row.external_id ?? row.id,
    company: row.company ?? row.account ?? "",
    domain: row.domain ?? row.company_domain ?? "",
    geography: row.geography || undefined,
    decision_maker: {
      full_name: name,
      email,
      linkedin_url: linkedin,
      role,
    },
    tech_hints: Array.isArray(row.tech_hints)
      ? row.tech_hints
      : typeof row.tech === "string" && row.tech
        ? [row.tech]
        : undefined,
    hiring_hints: Array.isArray(row.hiring_hints)
      ? row.hiring_hints
      : typeof row.hiring === "string" && row.hiring
        ? [row.hiring]
        : undefined,
    notes: row.notes || undefined,
    message: row.message || undefined,
    linkedin_url: linkedin,
    employee_band: row.employee_band,
    tier_hint: row.tier_hint,
    utm: row.utm,
  };
}

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
    return normalizeIngestRow(row);
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
          if (Array.isArray(json)) {
            leadsRaw = json;
          } else {
            const obj = json as { leads?: unknown[]; rows?: unknown[] };
            leadsRaw = obj.leads ?? obj.rows ?? [];
          }
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
        leadsRaw = parsed.data.leads ?? parsed.data.rows ?? [];
      }
    }

    const results: Array<{
      leadId: string;
      deduped: boolean;
      state: string;
      error?: string;
    }> = [];

    for (const raw of leadsRaw) {
      const parsed = LeadIngestSchema.safeParse(normalizeIngestRow(raw));
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
