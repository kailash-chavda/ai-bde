import { validatePortfolioRefs } from "@ai-bde/orchestrator";
import {
  AgencyLeadProfileSchema,
  normalizeDomain,
  type AgencyLeadProfile,
  type ApprovedCaseStudy,
  type LeadIngest,
} from "@ai-bde/schemas";

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Hard grounding for research LLM output: identity fields must match ingest;
 * no invented funding/product signals; schema must parse.
 */
export function validateResearchGrounding(input: {
  ingest: LeadIngest;
  candidate: unknown;
}): { ok: true; profile: AgencyLeadProfile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const parsed = AgencyLeadProfileSchema.safeParse(input.candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        `schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ],
    };
  }
  const profile = parsed.data;
  const expectedDomain = normalizeDomain(input.ingest.domain);
  if (profile.domain !== expectedDomain) {
    errors.push(
      `domain mismatch: got ${profile.domain}, expected ${expectedDomain}`,
    );
  }
  if (
    profile.company.trim().toLowerCase() !==
    input.ingest.company.trim().toLowerCase()
  ) {
    errors.push("company does not match ingest");
  }
  if (
    profile.decision_maker.full_name.trim().toLowerCase() !==
    input.ingest.decision_maker.full_name.trim().toLowerCase()
  ) {
    errors.push("decision_maker.full_name does not match ingest");
  }
  const ingestEmail = input.ingest.decision_maker.email?.toLowerCase();
  const outEmail = profile.decision_maker.email?.toLowerCase();
  if (ingestEmail && outEmail && ingestEmail !== outEmail) {
    errors.push("decision_maker.email does not match ingest");
  }
  if (!ingestEmail && outEmail) {
    errors.push("invented decision_maker.email not present in ingest");
  }

  // Tech names must appear in ingest text (hints / message / notes / role)
  const ingestText = [
    input.ingest.company,
    input.ingest.message ?? "",
    input.ingest.notes ?? "",
    ...(input.ingest.tech_hints ?? []),
    ...(input.ingest.hiring_hints ?? []),
    input.ingest.decision_maker.role,
  ]
    .join(" ")
    .toLowerCase();
  for (const tech of profile.detected_tech_stack) {
    const name = tech.name.toLowerCase();
    const needles = [name, name.replace(/\./g, ""), name.replace(/\s+/g, "")];
    if (!needles.some((n) => n && ingestText.includes(n))) {
      errors.push(`invented tech signal: ${tech.name}`);
    }
  }

  for (const hire of profile.hiring_signals) {
    const title = hire.title.toLowerCase();
    const allowed = (input.ingest.hiring_hints ?? []).map((h) =>
      h.toLowerCase(),
    );
    if (!allowed.some((h) => h === title || h.includes(title) || title.includes(h))) {
      errors.push(`invented hiring signal: ${hire.title}`);
    }
  }

  if (profile.funding_signals?.length) {
    errors.push("funding_signals not allowed unless present in ingest sources");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, profile };
}

/**
 * Hard grounding for copywriter LLM output: case_study_ids must be subset of
 * approved DB ids; portfolio language requires ids; metrics must come from
 * approved outcomes; no invented client names.
 */
export function validateCopywriterGrounding(input: {
  subject: string;
  body: string;
  matchedCaseStudyId: string | null;
  caseStudyIds: string[];
  approvedCaseStudies: ApprovedCaseStudy[];
}): { ok: boolean; errors: string[] } {
  const approvedIds = new Set(input.approvedCaseStudies.map((s) => s.id));
  const byId = new Map(input.approvedCaseStudies.map((s) => [s.id, s]));
  const portfolioCheck = validatePortfolioRefs({
    body: input.body,
    matchedCaseStudyId: input.matchedCaseStudyId,
    caseStudyIds: input.caseStudyIds,
    approvedCaseStudyIds: approvedIds,
  });
  const errors = [...portfolioCheck.errors];

  if (
    input.matchedCaseStudyId &&
    !input.caseStudyIds.includes(input.matchedCaseStudyId)
  ) {
    errors.push("matched_case_study_id missing from case_study_ids");
  }

  // Client names in body must appear on cited approved studies (or none cited)
  const cited = input.caseStudyIds
    .map((id) => byId.get(id))
    .filter((s): s is ApprovedCaseStudy => Boolean(s));
  const allowedClientNames = new Set(
    cited
      .flatMap((s) => [s.client_name, s.anonymized_label])
      .filter((n): n is string => Boolean(n))
      .map((n) => n.toLowerCase()),
  );
  // Detect "for <Name>" / "with <Name>" style invented clients when no cite
  const forClient = /\b(?:for|with)\s+([A-Z][A-Za-z0-9&.\-\s]{1,40})\b/g;
  let m: RegExpExecArray | null;
  const body = input.body;
  while ((m = forClient.exec(body)) !== null) {
    const name = m[1]!.trim().toLowerCase();
    // Skip common non-client phrases
    if (
      /^(your|our|the|a|an|us|you|them|teams?|engineering|discovery|peer)\b/.test(
        name,
      )
    ) {
      continue;
    }
    if (cited.length === 0) {
      // Without a case study cite, avoid proper-noun "for Acme" claims
      if (/^[A-Z]/.test(m[1]!.trim()) && !allowedClientNames.has(name)) {
        // Only flag if it looks like a company claim with portfolio language nearby
        const window = body.slice(
          Math.max(0, m.index - 40),
          m.index + m[0].length + 20,
        );
        if (/\b(built|shipped|delivered|client|case study)\b/i.test(window)) {
          errors.push(`possible invented client reference: ${m[1]!.trim()}`);
        }
      }
    } else if (
      /^[A-Z]/.test(m[1]!.trim()) &&
      !allowedClientNames.has(name) &&
      /\b(built|shipped|delivered|client)\b/i.test(
        body.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20),
      )
    ) {
      errors.push(`client name not on cited case studies: ${m[1]!.trim()}`);
    }
  }

  // Metric values in body must appear on cited studies' outcomes when portfolio cited
  if (cited.length) {
    const allowedValues = new Set(
      cited.flatMap((s) => s.outcomes.map((o) => o.value.toLowerCase())),
    );
    const metricLike = body.match(
      /\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?[kx]\b|\b\d{1,3}(?:,\d{3})+\b/gi,
    );
    if (metricLike) {
      for (const raw of metricLike) {
        const v = raw.toLowerCase();
        if (![...allowedValues].some((a) => a.includes(v) || v.includes(a))) {
          // Allow benign numbers like "15-minute"
          if (/\b15\b/.test(v) && /15[- ]?minute/i.test(body)) continue;
          errors.push(`metric/value not on cited outcomes: ${raw}`);
        }
      }
    }
  }

  const words = wordCount(input.body);
  if (words > 120) {
    errors.push(`word_count ${words} > 120`);
  }
  if (!input.subject?.trim()) {
    errors.push("subject required for email");
  }

  return { ok: errors.length === 0, errors };
}
