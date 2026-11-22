import type { InboundReplyEvent, ReplyClassification, Urgency } from "@ai-bde/schemas";

/**
 * Lightweight reply classification stub (full Triage Agent is Phase 3).
 * Used by inbound webhook to pause sequences + Discord high-intent hooks.
 */
export function classifyReplyStub(rawBody: string): {
  classification: ReplyClassification;
  urgency: Urgency;
  classification_confidence: number;
  escalate_to_human: boolean;
  escalation_reason: string | null;
} {
  const text = rawBody.toLowerCase();

  if (
    /\b(unsubscribe|opt[ -]?out|remove me|stop emailing|stop contacting)\b/.test(
      text,
    )
  ) {
    return {
      classification: "unsubscribe",
      urgency: "low",
      classification_confidence: 0.95,
      escalate_to_human: false,
      escalation_reason: null,
    };
  }

  if (
    /\b(book|calendar|discovery|let'?s (talk|chat|meet)|schedule a (call|meeting)|interested)\b/.test(
      text,
    )
  ) {
    return {
      classification: "interested_discovery_call",
      urgency: "high",
      classification_confidence: 0.7,
      escalate_to_human: true,
      escalation_reason: "High-intent reply — human confirmation (Phase 2 stub)",
    };
  }

  if (/\b(case study|portfolio|examples? of (your )?work)\b/.test(text)) {
    return {
      classification: "request_portfolio_case_study",
      urgency: "medium",
      classification_confidence: 0.7,
      escalate_to_human: true,
      escalation_reason: "Portfolio request — HITL for grounded reply",
    };
  }

  if (/\b(rate|pricing|budget|how much|cost|quote|timeline)\b/.test(text)) {
    return {
      classification: "rate_budget_inquiry",
      urgency: "high",
      classification_confidence: 0.75,
      escalate_to_human: true,
      escalation_reason: "Commercial inquiry — never auto-quote",
    };
  }

  if (/\b(not now|maybe later|next (quarter|year)|revisit)\b/.test(text)) {
    return {
      classification: "not_now",
      urgency: "low",
      classification_confidence: 0.7,
      escalate_to_human: false,
      escalation_reason: null,
    };
  }

  if (/\b(refer|introduce you|colleague|someone else)\b/.test(text)) {
    return {
      classification: "referral",
      urgency: "medium",
      classification_confidence: 0.65,
      escalate_to_human: true,
      escalation_reason: "Referral path — human follow-up",
    };
  }

  return {
    classification: "unclear",
    urgency: "medium",
    classification_confidence: 0.2,
    escalate_to_human: true,
    escalation_reason:
      "Triage stub — unclear classification; human review required",
  };
}

/**
 * Phase 2 stub — classifies inbound for pause + Discord hooks.
 * Does not auto-send replies (Phase 3).
 */
export function runTriageAgentStub(input: {
  leadId: string;
  threadId: string;
  rawBody: string;
}): InboundReplyEvent {
  const classified = classifyReplyStub(input.rawBody);
  return {
    lead_id: input.leadId,
    thread_id: input.threadId,
    classification: classified.classification,
    urgency: classified.urgency,
    extracted_requirements: [],
    suggested_reply: null,
    escalate_to_human: classified.escalate_to_human,
    escalation_reason: classified.escalation_reason,
    channel: "email_inbound",
    raw_body: input.rawBody,
    classification_confidence: classified.classification_confidence,
    suggested_reply_hitl_status: classified.escalate_to_human
      ? "pending"
      : undefined,
  };
}
