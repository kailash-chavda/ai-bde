import type { InboundReplyEvent } from "@ai-bde/schemas";

/**
 * Phase 1 stub — Triage Agent is Phase 3.
 * Returns a safe escalate-to-human classification without auto-send.
 */
export function runTriageAgentStub(input: {
  leadId: string;
  threadId: string;
  rawBody: string;
}): InboundReplyEvent {
  return {
    lead_id: input.leadId,
    thread_id: input.threadId,
    classification: "unclear",
    urgency: "medium",
    extracted_requirements: [],
    suggested_reply: null,
    escalate_to_human: true,
    escalation_reason:
      "Triage Agent is a Phase 3 stub — all inbound requires human review in Phase 1",
    channel: "email_inbound",
    raw_body: input.rawBody,
    classification_confidence: 0,
    suggested_reply_hitl_status: "pending",
  };
}
