import {
  LEAD_TRANSITIONS,
  type HitlStatus,
  type LeadState,
  type LeadTier,
  type OutreachChannel,
} from "@ai-bde/schemas";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: LeadState,
    public readonly to: LeadState,
  ) {
    super(`Invalid lead transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: LeadState, to: LeadState): boolean {
  return (LEAD_TRANSITIONS[from] as readonly LeadState[]).includes(to);
}

export function assertTransition(from: LeadState, to: LeadState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export interface TransitionRequest {
  from: LeadState;
  to: LeadState;
  reason: string;
  actor: string;
}

export interface TransitionResult {
  from: LeadState;
  to: LeadState;
  reason: string;
  actor: string;
  at: string;
}

export function planTransition(req: TransitionRequest): TransitionResult {
  assertTransition(req.from, req.to);
  if (!req.reason.trim()) {
    throw new Error("Transition reason is required");
  }
  if (!req.actor.trim()) {
    throw new Error("Transition actor is required");
  }
  return {
    from: req.from,
    to: req.to,
    reason: req.reason,
    actor: req.actor,
    at: new Date().toISOString(),
  };
}

/** Phase 1: HITL required on every outbound send */
export function requiresHitl(input: {
  channel: OutreachChannel;
  stepIndex: number;
  tier?: LeadTier | null;
  phase?: 1 | 2 | 3;
}): boolean {
  const phase = input.phase ?? 1;
  if (phase === 1) return true;
  if (input.tier === "tier1_enterprise" && input.stepIndex === 1) return true;
  return input.channel === "email";
}

export interface DispatchGateInput {
  hitlStatus: HitlStatus;
  requiresHitl: boolean;
  suppressed: boolean;
  leadPaused: boolean;
  caseStudyIds: string[];
  approvedCaseStudyIds: Set<string>;
  inboxActive: boolean;
  dailyCapRemaining: number;
  withinSendWindow: boolean;
}

export type DispatchBlockReason =
  | "hitl_pending"
  | "hitl_rejected"
  | "suppressed"
  | "lead_paused"
  | "unapproved_case_study"
  | "inbox_inactive"
  | "daily_cap"
  | "outside_send_window";

export interface DispatchGateResult {
  allowed: boolean;
  blockReasons: DispatchBlockReason[];
}

/**
 * Orchestrator send gates. Phase 1: never send without HITL approved.
 * Portfolio integrity: every cited case_study_id must be approved.
 */
export function evaluateDispatchGates(
  input: DispatchGateInput,
): DispatchGateResult {
  const blockReasons: DispatchBlockReason[] = [];

  if (input.suppressed) blockReasons.push("suppressed");
  if (input.leadPaused) blockReasons.push("lead_paused");

  if (input.requiresHitl) {
    if (input.hitlStatus === "pending") blockReasons.push("hitl_pending");
    if (input.hitlStatus === "rejected") blockReasons.push("hitl_rejected");
    if (input.hitlStatus !== "approved" && input.hitlStatus !== "sent") {
      if (!blockReasons.includes("hitl_pending") && input.hitlStatus !== "rejected") {
        blockReasons.push("hitl_pending");
      }
    }
  }

  for (const id of input.caseStudyIds) {
    if (!input.approvedCaseStudyIds.has(id)) {
      blockReasons.push("unapproved_case_study");
      break;
    }
  }

  if (!input.inboxActive) blockReasons.push("inbox_inactive");
  if (input.dailyCapRemaining <= 0) blockReasons.push("daily_cap");
  if (!input.withinSendWindow) blockReasons.push("outside_send_window");

  return {
    allowed: blockReasons.length === 0,
    blockReasons,
  };
}

export function validatePortfolioRefs(input: {
  body: string;
  matchedCaseStudyId: string | null;
  caseStudyIds: string[];
  approvedCaseStudyIds: Set<string>;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const allIds = new Set(input.caseStudyIds);
  if (input.matchedCaseStudyId) allIds.add(input.matchedCaseStudyId);

  for (const id of allIds) {
    if (!input.approvedCaseStudyIds.has(id)) {
      errors.push(`case_study_id ${id} is not approved`);
    }
  }

  // If body mentions "case study" / portfolio language, require a resolvable id
  const citesPortfolio =
    /\b(case study|portfolio|we (built|shipped|delivered) for)\b/i.test(
      input.body,
    );
  if (citesPortfolio && allIds.size === 0) {
    errors.push(
      "Body cites portfolio/case study without a resolvable case_study_id",
    );
  }

  return { ok: errors.length === 0, errors };
}

export function afterHitlApprove(from: LeadState): LeadState {
  assertTransition(from, "Contacted");
  return "Contacted";
}

export function afterHitlReject(from: LeadState): LeadState {
  // Reject → rewrite: QueuedForApproval → Enriched
  if (from === "QueuedForApproval") {
    assertTransition(from, "Enriched");
    return "Enriched";
  }
  return from;
}

export const redisKeys = {
  inboxSent: (inboxId: string, ymd: string) =>
    `inbox:${inboxId}:sent:${ymd}`,
  seqDue: "seq:due",
  lockLead: (leadId: string) => `lock:lead:${leadId}`,
  lockSend: (idempotencyKey: string) => `lock:send:${idempotencyKey}`,
} as const;
