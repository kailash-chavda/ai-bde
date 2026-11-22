import { validatePortfolioRefs } from "@ai-bde/orchestrator";
import type {
  AgencyLeadProfile,
  ApprovedCaseStudy,
  OutreachSequenceItem,
} from "@ai-bde/schemas";
import { validateCopywriterGrounding, wordCount } from "./grounding.js";
import {
  GLOBAL_GROUNDING_PROMPT,
  chatJson,
  getLlmConfig,
} from "./llm.js";

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
  /** Model label stored on agent_runs */
  model: string;
  /** Set when LLM was attempted but discarded */
  llmFallbackReason?: string;
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

function buildDraftResult(
  input: CopywriterInput,
  draftFields: {
    subject: string;
    body: string;
    matchedCaseStudyId: string | null;
    caseStudyIds: string[];
    observationUsed: string;
  },
  model: string,
  llmFallbackReason?: string,
): CopywriterResult {
  const approvedIds = new Set(input.approvedCaseStudies.map((s) => s.id));
  const portfolioCheck = validatePortfolioRefs({
    body: draftFields.body,
    matchedCaseStudyId: draftFields.matchedCaseStudyId,
    caseStudyIds: draftFields.caseStudyIds,
    approvedCaseStudyIds: approvedIds,
  });

  const words = wordCount(draftFields.body);
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
      subject: draftFields.subject,
      body: draftFields.body,
      char_count: draftFields.body.length,
      matched_case_study_id: draftFields.matchedCaseStudyId,
      case_study_ids: draftFields.caseStudyIds,
      hitl_status: "pending",
      requires_hitl: true,
      step_index: input.stepIndex ?? 1,
      idempotency_key: `${input.leadId}:email:step:${input.stepIndex ?? 1}`,
    },
    observationUsed: draftFields.observationUsed,
    needsHuman,
    reason,
    model,
    llmFallbackReason,
  };
}

/**
 * Phase 1 Copywriter — email only (deterministic).
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

  return buildDraftResult(
    input,
    {
      subject,
      body,
      matchedCaseStudyId: matchedId,
      caseStudyIds,
      observationUsed: observation,
    },
    "deterministic-v1",
  );
}

interface LlmCopyResponse {
  subject?: string;
  body?: string;
  word_count?: number;
  matched_case_study_id?: string | null;
  case_study_ids?: string[];
  observation_used?: string;
  needs_human?: boolean;
  reason?: string | null;
}

/**
 * Copywriter with optional LLM. Fail-closed to deterministic draft if the LLM
 * invents clients/metrics or cites case_study_ids not in the approved set.
 */
export async function runCopywriterAgentAsync(
  input: CopywriterInput,
): Promise<CopywriterResult> {
  const deterministic = runCopywriterAgent(input);
  const cfg = getLlmConfig();
  if (!cfg) return deterministic;

  const sender = input.senderName ?? "Alex";
  const requireUnsubscribe = input.requireUnsubscribe !== false;
  const contextStudies = input.approvedCaseStudies.map((s) => ({
    id: s.id,
    title: s.title,
    anonymized_label: s.anonymized_label,
    client_name: s.client_name,
    summary: s.summary,
    outcomes: s.outcomes,
    tech_tags: s.tech_tags,
    service_pillars: s.service_pillars,
    approved: true as const,
  }));

  try {
    const { data, model } = await chatJson<LlmCopyResponse>({
      system: `${GLOBAL_GROUNDING_PROMPT}

SYSTEM — COLD EMAIL COPYWRITER

Follow GLOBAL GROUNDING.
Channel: email. Target body: under 120 words. Peer-level.
Structure:
  1) One concrete tech/business observation from CONTEXT.lead (must cite a real signal).
  2) One relevant capability tied to matched_service_pillar.
  3) Optional ONE case study reference via matched_case_study_id from CONTEXT.case_studies.
  4) Soft CTA: 15-min discovery or reply with timing — no hard sell.
  5) Sign-off with sender name from CONTEXT.sender; unsubscribe footer if required.

Forbidden: attachments claims, "guaranteed", fake social proof, multiple CTAs, HTML gimmicks.
case_study_ids MUST be a subset of CONTEXT.case_studies[].id — never invent UUIDs.`,
      user: JSON.stringify({
        CONTEXT: {
          lead: input.profile,
          case_studies: contextStudies,
          sender,
          sequence_step: input.stepIndex ?? 1,
          require_unsubscribe: requireUnsubscribe,
          prior_touches: [],
        },
        TASK: `Draft step ${input.stepIndex ?? 1} cold email.`,
        ReturnJSON: {
          subject: "string",
          body: "string",
          word_count: "number",
          matched_case_study_id: "string | null",
          case_study_ids: "string[]",
          observation_used: "string",
          needs_human: "boolean",
          reason: "string | null",
        },
      }),
      temperature: 0.3,
    });

    const subject = typeof data.subject === "string" ? data.subject : "";
    const body = typeof data.body === "string" ? data.body : "";
    const matched =
      typeof data.matched_case_study_id === "string"
        ? data.matched_case_study_id
        : null;
    const caseStudyIds = Array.isArray(data.case_study_ids)
      ? data.case_study_ids.filter((id): id is string => typeof id === "string")
      : matched
        ? [matched]
        : [];
    const observation =
      typeof data.observation_used === "string" && data.observation_used
        ? data.observation_used
        : observationFromProfile(input.profile);

    const grounded = validateCopywriterGrounding({
      subject,
      body,
      matchedCaseStudyId: matched,
      caseStudyIds,
      approvedCaseStudies: input.approvedCaseStudies,
    });

    if (!grounded.ok) {
      return {
        ...deterministic,
        llmFallbackReason: grounded.errors.join("; "),
      };
    }

    // Force HITL on every send (Phase 1)
    const result = buildDraftResult(
      input,
      {
        subject,
        body,
        matchedCaseStudyId: matched,
        caseStudyIds,
        observationUsed: observation,
      },
      model,
    );
    return {
      ...result,
      needsHuman: true,
      reason: data.reason ?? result.reason,
    };
  } catch (err) {
    return {
      ...deterministic,
      llmFallbackReason:
        err instanceof Error ? err.message : "LLM copywriter failed",
    };
  }
}
