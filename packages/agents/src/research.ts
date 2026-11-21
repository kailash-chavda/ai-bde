import {
  ENRICHMENT_VERSION,
  GeographySchema,
  normalizeDomain,
  type AgencyLeadProfile,
  type DecisionMaker,
  type Geography,
  type LeadIngest,
  type LeadTier,
  type ServicePillar,
  type SourceRef,
  type TechStackSignal,
} from "@ai-bde/schemas";

const AGENCY_DOMAIN_HINTS = [
  "agency",
  "studio",
  "consulting",
  "consultants",
  "freelance",
  "freelancer",
];

const PILLAR_KEYWORDS: Array<{ pillar: ServicePillar; keywords: string[] }> = [
  {
    pillar: "healthcare_medtech",
    keywords: ["hipaa", "health", "medtech", "patient", "clinical", "ehr", "fhir"],
  },
  {
    pillar: "mobile_native",
    keywords: ["ios", "android", "swift", "kotlin", "app store", "play store"],
  },
  {
    pillar: "mobile_cross_platform",
    keywords: ["flutter", "react native", "rn ", "cross-platform mobile"],
  },
  {
    pillar: "ecommerce",
    keywords: ["shopify", "ecommerce", "e-commerce", "checkout", "cart"],
  },
  {
    pillar: "erp",
    keywords: ["erp", "sap", "odoo", "netsuite", "inventory"],
  },
  {
    pillar: "web_saas",
    keywords: ["saas", "next.js", "react", "node", "laravel", "full-stack", "web app"],
  },
];

export interface ResearchInput {
  ingest: LeadIngest;
  sourceLabel: string;
}

export interface ResearchResult {
  profile: AgencyLeadProfile;
  disqualify: boolean;
  disqualifyReason?: string;
}

function inferSeniority(
  role: string,
): DecisionMaker["seniority"] {
  const r = role.toLowerCase();
  if (/\b(ceo|cto|cpo|coo|founder|co-founder)\b/.test(r)) return "c_level";
  if (/\bvp\b|vice president/.test(r)) return "vp";
  if (/\bdirector\b/.test(r)) return "director";
  if (/\bmanager\b|head of\b/.test(r)) return "manager";
  return "unknown";
}

function collectText(ingest: LeadIngest): string {
  return [
    ingest.company,
    ingest.message ?? "",
    ingest.notes ?? "",
    ...(ingest.tech_hints ?? []),
    ...(ingest.hiring_hints ?? []),
    ingest.decision_maker.role,
  ]
    .join(" ")
    .toLowerCase();
}

function matchPillar(text: string): ServicePillar | null {
  for (const row of PILLAR_KEYWORDS) {
    if (row.keywords.some((k) => text.includes(k))) return row.pillar;
  }
  return null;
}

function detectTech(text: string, source: SourceRef): TechStackSignal[] {
  const signals: TechStackSignal[] = [];
  const map: Array<{
    name: string;
    category: TechStackSignal["category"];
    needles: string[];
  }> = [
    { name: "React", category: "frontend", needles: ["react"] },
    { name: "Next.js", category: "frontend", needles: ["next.js", "nextjs"] },
    { name: "Node.js", category: "backend", needles: ["node", "node.js"] },
    { name: "Flutter", category: "mobile", needles: ["flutter"] },
    {
      name: "React Native",
      category: "mobile",
      needles: ["react native"],
    },
    { name: "Swift", category: "mobile", needles: ["swift", "ios"] },
    { name: "Kotlin", category: "mobile", needles: ["kotlin", "android"] },
    { name: "Laravel", category: "backend", needles: ["laravel"] },
  ];
  for (const row of map) {
    if (row.needles.some((n) => text.includes(n))) {
      signals.push({
        name: row.name,
        category: row.category,
        evidence: `Mentioned in ingest context: ${row.name}`,
        source,
      });
    }
  }
  return signals;
}

function parseGeography(raw?: string): Geography {
  if (!raw) return "Other";
  const parsed = GeographySchema.safeParse(raw);
  return parsed.success ? parsed.data : "Other";
}

function inferTier(ingest: LeadIngest): LeadTier | undefined {
  if (ingest.tier_hint) return ingest.tier_hint;
  const band = ingest.employee_band ?? "";
  if (/1000\+|5000|enterprise/i.test(band)) return "tier1_enterprise";
  if (/201-500|501-1000|51-200/i.test(band)) return "mid_market";
  if (band) return "smb";
  return undefined;
}

/**
 * Phase 1 Research Agent — deterministic enrichment from provided ingest only.
 * Never invents funding, ratings, or tech not present in sources.
 */
export function runResearchAgent(input: ResearchInput): ResearchResult {
  const domain = normalizeDomain(input.ingest.domain);
  const now = new Date().toISOString();
  const source: SourceRef = {
    type: "manual",
    title: input.sourceLabel,
    retrieved_at: now,
    snippet: input.ingest.message ?? input.ingest.notes,
  };

  const text = collectText(input.ingest);
  const dm: DecisionMaker = {
    ...input.ingest.decision_maker,
    seniority:
      input.ingest.decision_maker.seniority ??
      inferSeniority(input.ingest.decision_maker.role),
  };

  const icpFailReasons: string[] = [];
  const domainLower = domain.toLowerCase();
  if (AGENCY_DOMAIN_HINTS.some((h) => domainLower.includes(h) || text.includes(` ${h} `))) {
    icpFailReasons.push("Likely agency/competitor domain or positioning");
  }
  if (!dm.email && !dm.linkedin_url) {
    icpFailReasons.push("Missing decision-maker contact path (email or LinkedIn)");
  }
  if (!dm.full_name.trim()) {
    icpFailReasons.push("Missing decision-maker name");
  }

  const matched = matchPillar(text);
  const tech = detectTech(text, source);
  const hiring = (input.ingest.hiring_hints ?? []).map((title) => ({
    title,
    signals: ["engineering_bottleneck" as const],
    source,
  }));

  let confidence = 0.35;
  if (dm.email) confidence += 0.2;
  if (dm.linkedin_url) confidence += 0.1;
  if (matched) confidence += 0.15;
  if (tech.length) confidence += 0.1;
  if (hiring.length) confidence += 0.1;
  confidence = Math.min(1, Math.round(confidence * 1000) / 1000);

  const icpPass = icpFailReasons.length === 0 && confidence >= 0.4;

  const profile: AgencyLeadProfile = {
    company: input.ingest.company.trim(),
    domain,
    decision_maker: dm,
    role: dm.role,
    geography: parseGeography(input.ingest.geography),
    detected_tech_stack: tech,
    hiring_signals: hiring,
    matched_service_pillar: matched,
    confidence_score: confidence,
    sources: [source],
    tier: inferTier(input.ingest),
    employee_band: input.ingest.employee_band,
    icp_pass: icpPass,
    icp_fail_reasons: icpFailReasons.length ? icpFailReasons : undefined,
    enrichment_version: ENRICHMENT_VERSION,
    enriched_at: now,
  };

  if (!icpPass) {
    return {
      profile,
      disqualify: true,
      disqualifyReason: icpFailReasons.join("; ") || "ICP confidence below threshold",
    };
  }

  if (!matched) {
    return {
      profile: { ...profile, icp_pass: false, icp_fail_reasons: ["No service pillar match"] },
      disqualify: true,
      disqualifyReason: "No service pillar match from available signals",
    };
  }

  return { profile, disqualify: false };
}
