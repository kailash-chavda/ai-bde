import { validatePortfolioRefs } from "@ai-bde/orchestrator";
import type {
  AgencyLeadProfile,
  ApprovedCaseStudy,
  OutreachSequenceItem,
} from "@ai-bde/schemas";

export interface CopywriterInput {
  leadId: string;
  profile: AgencyLeadProfile;
  /** Only approved case studies may be passed — never unapproved */
  approvedCaseStudies: ApprovedCaseStudy[];
  stepIndex?: number;
  senderName?: string;
  requireUnsubscribe?: boolean;
}

export interface CopywriterResult {
  draft: Omit<
    OutreachSequenceItem,
    "id" | "created_at" | "updated_at" | "sent_at"
  >;
  observationUsed: string;
  needsHuman: boolean;
  reason: string | null;
}

function pickCaseStudy(
  profile: AgencyLeadProfile,
  studies: ApprovedCaseStudy[],
): ApprovedCaseStudy | null {
  if (!studies.length) return null;
  const pillar = profile.matched_service_pillar;
  if (pillar) {
    const match = studies.find((s) => s.service_pillars.includes(pillar));
    if (match) return match;
  }
  const techNames = new Set(
    profile.detected_tech_stack.map((t) => t.name.toLowerCase()),
  );
  const byTech = studies.find((s) =>
    s.tech_tags.some((t) => techNames.has(t.toLowerCase())),
  );
  return byTech ?? null;
}

function observationFromProfile(profile: AgencyLeadProfile): string {
  if (profile.hiring_signals[0]) {
    return `you're hiring for ${profile.hiring_signals[0].title}`;
  }
  if (profile.detected_tech_stack[0]) {
    return `your stack includes ${profile.detected_tech_stack[0].name}`;
  }
  if (profile.matched_service_pillar) {
    return `you're exploring ${profile.matched_service_pillar.replace(/_/g, " ")} work`;
  }
  return "your product roadmap";
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Phase 1 Copywriter — email only.
 * Grounds portfolio claims ONLY in approved case_study_id from CONTEXT.
 * Never invents clients, metrics, or outcomes.
 */
export function runCopywriterAgent(input: CopywriterInput): CopywriterResult {
  const sender = input.senderName ?? "Alex";
  const study = pickCaseStudy(input.profile, input.approvedCaseStudies);
  const observation = observationFromProfile(input.profile);
  const dmFirst =
    input.profile.decision_maker.full_name.split(/\s+/)[0] ?? "there";

  let portfolioSentence = "";
  let matchedId: string | null = null;
  const caseStudyIds: string[] = [];

  if (study) {
    matchedId = study.id;
    caseStudyIds.push(study.id);
    const label = study.anonymized_label ?? study.client_name;
    // Prefer anonymized_label when client_name is null; never invent a client
    const ref = label
      ? `relevant to ${label}`
      : `aligned with our approved ${study.title} case study`;
    const outcome = study.outcomes[0];
    if (outcome?.verified) {
      portfolioSentence = ` We have an approved case study ${ref} (${outcome.metric}: ${outcome.value}).`;
    } else {
      portfolioSentence = ` We have an approved case study ${ref} if useful.`;
    }
  }

  const bodyParts = [
    `Hi ${dmFirst},`,
    ``,
    `Noticed ${observation} at ${input.profile.company}.`,
    `We help teams with ${
      input.profile.matched_service_pillar?.replace(/_/g, " ") ?? "software delivery"
    } as peer engineering capacity.${portfolioSentence}`,
    `Open to a 15-minute discovery call, or reply with a better time?`,
    ``,
    `— ${sender}`,
  ];

  if (input.requireUnsubscribe !== false) {
    bodyParts.push(``, `Unsubscribe: reply "unsubscribe"`);
  }

  const body = bodyParts.join("\n");
  const subject = `${input.profile.company} — quick ${
    input.profile.matched_service_pillar?.replace(/_/g, " ") ?? "engineering"
  } note`;

  const approvedIds = new Set(input.approvedCaseStudies.map((s) => s.id));
  const portfolioCheck = validatePortfolioRefs({
    body,
    matchedCaseStudyId: matchedId,
    caseStudyIds,
    approvedCaseStudyIds: approvedIds,
  });

  const words = wordCount(body);
  const needsHuman = !portfolioCheck.ok || words > 120;
  const reason = needsHuman
    ? [...portfolioCheck.errors, words > 120 ? `word_count ${words} > 120` : null]
        .filter(Boolean)
        .join("; ")
    : null;

  return {
    draft: {
      lead_id: input.leadId,
      channel: "email",
      subject,
      body,
      char_count: body.length,
      matched_case_study_id: matchedId,
      case_study_ids: caseStudyIds,
      hitl_status: "pending",
      requires_hitl: true,
      step_index: input.stepIndex ?? 1,
      idempotency_key: `${input.leadId}:email:step:${input.stepIndex ?? 1}`,
    },
    observationUsed: observation,
    needsHuman,
    reason,
  };
}
