import {
  SequenceTemplateStepsSchema,
  TEMPLATE_EMAIL_3_STEP,
  TEMPLATE_EMAIL_5_STEP,
  type LeadTier,
  type SequenceTemplateStep,
  type SequenceTemplateSteps,
} from "@ai-bde/schemas";

export const SEQUENCE_PAUSE_REASONS = {
  reply: "inbound_reply",
  calendar: "calendar_booked",
  optOut: "opt_out",
  suppression: "suppression",
  manual: "manual_pause",
} as const;

export type SequencePauseReason =
  (typeof SEQUENCE_PAUSE_REASONS)[keyof typeof SEQUENCE_PAUSE_REASONS];

/** Terminal pause reasons — resume API refuses these. */
export const TERMINAL_PAUSE_REASONS = new Set<string>([
  SEQUENCE_PAUSE_REASONS.calendar,
  SEQUENCE_PAUSE_REASONS.optOut,
  SEQUENCE_PAUSE_REASONS.suppression,
]);

export function parseSequenceSteps(raw: unknown): SequenceTemplateSteps {
  return SequenceTemplateStepsSchema.parse(raw);
}

export function getStep(
  steps: SequenceTemplateSteps,
  stepIndex: number,
): SequenceTemplateStep | undefined {
  return steps.find((s) => s.step_index === stepIndex);
}

export function getNextEmailStep(
  steps: SequenceTemplateSteps,
  afterStepIndex: number,
): SequenceTemplateStep | undefined {
  const ordered = [...steps]
    .filter((s) => s.channel === "email")
    .sort((a, b) => a.step_index - b.step_index);
  return ordered.find((s) => s.step_index > afterStepIndex);
}

/** Mon–Fri only; skips Sat/Sun. */
export function addBusinessDays(from: Date, days: number): Date {
  if (days <= 0) return new Date(from.getTime());
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const dow = result.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return result;
}

/**
 * When HITL approves step N, schedule send at max(now, lastSent + delay).
 * Step 1 with delay 0 → immediate.
 */
export function computeScheduledAt(input: {
  delayBusinessDays: number;
  lastSentAt?: Date | null;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  if (input.delayBusinessDays <= 0 && !input.lastSentAt) return now;
  const base = input.lastSentAt ?? now;
  const delayed = addBusinessDays(base, input.delayBusinessDays);
  return delayed.getTime() > now.getTime() ? delayed : now;
}

/** Adaptive template: Tier-1 → 5-step nurture; others → 3-step. Email only. */
export function selectEmailTemplateId(tier?: LeadTier | null): string {
  if (tier === "tier1_enterprise") return TEMPLATE_EMAIL_5_STEP;
  return TEMPLATE_EMAIL_3_STEP;
}

export function isResumablePause(pauseReason: string | null | undefined): boolean {
  if (!pauseReason) return true;
  return !TERMINAL_PAUSE_REASONS.has(pauseReason);
}

/** High-intent reply classifications that warrant Slack alerts. */
export const HIGH_INTENT_CLASSIFICATIONS = new Set([
  "interested_discovery_call",
  "request_portfolio_case_study",
  "rate_budget_inquiry",
  "referral",
]);

export function isHighIntentClassification(classification: string): boolean {
  return HIGH_INTENT_CLASSIFICATIONS.has(classification);
}
