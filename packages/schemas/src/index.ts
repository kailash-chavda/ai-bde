import { z } from "zod";

/** Service pillars the agency sells — used for matching & RAG filters */
export const ServicePillarSchema = z.enum([
  "mobile_native",
  "mobile_cross_platform",
  "web_saas",
  "healthcare_medtech",
  "ecommerce",
  "erp",
]);
export type ServicePillar = z.infer<typeof ServicePillarSchema>;

export const LeadSourceSchema = z.enum([
  "csv",
  "sales_navigator",
  "job_board",
  "website_form",
  "webhook",
  "crm_import",
  "manual",
]);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const LeadStateSchema = z.enum([
  "New",
  "Enriched",
  "QueuedForApproval",
  "Contacted",
  "Replied",
  "DiscoveryBooked",
  "Disqualified",
  "DoNotContact",
]);
export type LeadState = z.infer<typeof LeadStateSchema>;

export const LeadTierSchema = z.enum(["smb", "mid_market", "tier1_enterprise"]);
export type LeadTier = z.infer<typeof LeadTierSchema>;

export const GeographySchema = z.enum([
  "US",
  "UK",
  "EU",
  "MEA",
  "India",
  "APAC",
  "LATAM",
  "Other",
]);
export type Geography = z.infer<typeof GeographySchema>;

export const OutreachChannelSchema = z.enum([
  "email",
  "linkedin_connect",
  "linkedin_dm",
]);
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>;

export const HitlStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "sent",
]);
export type HitlStatus = z.infer<typeof HitlStatusSchema>;

export const ReplyClassificationSchema = z.enum([
  "interested_discovery_call",
  "request_portfolio_case_study",
  "rate_budget_inquiry",
  "objection_in_house_team",
  "not_now",
  "referral",
  "unsubscribe",
  "other",
  "unclear",
]);
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

export const UrgencySchema = z.enum(["low", "medium", "high", "critical"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const SourceRefSchema = z.object({
  type: z.enum([
    "website",
    "linkedin",
    "job_post",
    "app_store",
    "crunchbase",
    "news",
    "crm",
    "manual",
    "other",
  ]),
  url: z.string().url().optional(),
  title: z.string().optional(),
  retrieved_at: z.string(),
  snippet: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const DecisionMakerSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email().optional(),
  linkedin_url: z.string().url().optional(),
  role: z.string().min(1),
  seniority: z
    .enum(["c_level", "vp", "director", "manager", "ic", "unknown"])
    .optional(),
});
export type DecisionMaker = z.infer<typeof DecisionMakerSchema>;

export const TechStackSignalSchema = z.object({
  name: z.string().min(1),
  category: z.enum([
    "mobile",
    "frontend",
    "backend",
    "cloud",
    "data",
    "devops",
    "other",
  ]),
  evidence: z.string().min(1),
  source: SourceRefSchema,
});
export type TechStackSignal = z.infer<typeof TechStackSignalSchema>;

export const HiringSignalSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  posted_at: z.string().optional(),
  signals: z.array(
    z.enum([
      "mobile_hiring",
      "fullstack_hiring",
      "engineering_bottleneck",
      "contract_or_agency_language",
      "backfill",
    ]),
  ),
  source: SourceRefSchema,
});
export type HiringSignal = z.infer<typeof HiringSignalSchema>;

export const AgencyLeadProfileSchema = z.object({
  company: z.string().min(1),
  domain: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
  decision_maker: DecisionMakerSchema,
  role: z.string().min(1),
  geography: GeographySchema,
  detected_tech_stack: z.array(TechStackSignalSchema),
  hiring_signals: z.array(HiringSignalSchema),
  matched_service_pillar: ServicePillarSchema.nullable(),
  confidence_score: z.number().min(0).max(1),
  sources: z.array(SourceRefSchema).min(1),
  tier: LeadTierSchema.optional(),
  employee_band: z.string().optional(),
  funding_signals: z
    .array(
      z.object({
        round: z.string().optional(),
        amount_usd: z.number().optional(),
        announced_at: z.string().optional(),
        source: SourceRefSchema,
      }),
    )
    .optional(),
  product_signals: z
    .array(
      z.object({
        kind: z.enum([
          "app_store_rating",
          "app_store_bugs",
          "outdated_stack",
          "compliance",
          "erp_gap",
          "other",
        ]),
        detail: z.string(),
        source: SourceRefSchema,
      }),
    )
    .optional(),
  icp_pass: z.boolean(),
  icp_fail_reasons: z.array(z.string()).optional(),
  enrichment_version: z.string(),
  enriched_at: z.string(),
});
export type AgencyLeadProfile = z.infer<typeof AgencyLeadProfileSchema>;

export const OutreachSequenceItemSchema = z.object({
  lead_id: z.string().uuid(),
  channel: OutreachChannelSchema,
  subject: z.string().nullable(),
  body: z.string().min(1),
  char_count: z.number().int().min(0),
  matched_case_study_id: z.string().uuid().nullable(),
  hitl_status: HitlStatusSchema,
  id: z.string().uuid().optional(),
  sequence_id: z.string().uuid().optional(),
  step_index: z.number().int().positive().optional(),
  requires_hitl: z.boolean().optional(),
  case_study_ids: z.array(z.string().uuid()).optional(),
  inbox_id: z.string().uuid().nullable().optional(),
  scheduled_at: z.string().nullable().optional(),
  sent_at: z.string().nullable().optional(),
  provider_message_id: z.string().nullable().optional(),
  idempotency_key: z.string().optional(),
  rejection_reason: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type OutreachSequenceItem = z.infer<typeof OutreachSequenceItemSchema>;

export const InboundReplyEventSchema = z.object({
  lead_id: z.string().uuid(),
  thread_id: z.string().min(1),
  classification: ReplyClassificationSchema,
  urgency: UrgencySchema,
  extracted_requirements: z.array(z.string()),
  suggested_reply: z.string().nullable(),
  escalate_to_human: z.boolean(),
  escalation_reason: z.string().nullable(),
  id: z.string().uuid().optional(),
  channel: z
    .union([
      OutreachChannelSchema,
      z.literal("email_inbound"),
      z.literal("linkedin_inbound"),
    ])
    .optional(),
  raw_message_id: z.string().optional(),
  raw_body: z.string().optional(),
  classification_confidence: z.number().min(0).max(1).optional(),
  suggested_reply_case_study_ids: z.array(z.string().uuid()).optional(),
  suggested_reply_hitl_status: HitlStatusSchema.optional(),
  calendar_link_included: z.boolean().optional(),
  received_at: z.string().optional(),
  processed_at: z.string().optional(),
});
export type InboundReplyEvent = z.infer<typeof InboundReplyEventSchema>;

/** Ingest payloads */
export const LeadIngestSchema = z.object({
  idempotency_key: z.string().min(1).optional(),
  external_id: z.string().min(1).optional(),
  company: z.string().min(1),
  domain: z.string().min(1),
  decision_maker: DecisionMakerSchema,
  geography: GeographySchema.optional(),
  message: z.string().optional(),
  notes: z.string().optional(),
  tech_hints: z.array(z.string()).optional(),
  hiring_hints: z.array(z.string()).optional(),
  linkedin_url: z.string().url().optional(),
  employee_band: z.string().optional(),
  tier_hint: LeadTierSchema.optional(),
  utm: z
    .object({
      source: z.string().optional(),
      campaign: z.string().optional(),
    })
    .optional(),
});
export type LeadIngest = z.infer<typeof LeadIngestSchema>;

export const CaseStudyCreateSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  service_pillars: z.array(ServicePillarSchema).min(1),
  industries: z.array(z.string()).default([]),
  tech_tags: z.array(z.string()).default([]),
  summary: z.string().min(1),
  outcomes: z
    .array(
      z.object({
        metric: z.string(),
        value: z.string(),
        verified: z.literal(true),
      }),
    )
    .default([]),
  client_name: z.string().nullable().optional(),
  anonymized_label: z.string().nullable().optional(),
  /** Public portfolio / source URL for claim grounding */
  source_url: z.string().url().nullable().optional(),
});
export type CaseStudyCreate = z.infer<typeof CaseStudyCreateSchema>;

export const ApprovedCaseStudySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  service_pillars: z.array(ServicePillarSchema),
  industries: z.array(z.string()),
  tech_tags: z.array(z.string()),
  summary: z.string(),
  outcomes: z.array(
    z.object({
      metric: z.string(),
      value: z.string(),
      verified: z.boolean(),
    }),
  ),
  client_name: z.string().nullable(),
  anonymized_label: z.string().nullable(),
  source_url: z.string().nullable().optional(),
  approved: z.literal(true),
});
export type ApprovedCaseStudy = z.infer<typeof ApprovedCaseStudySchema>;

export const ENRICHMENT_VERSION = "1.0.0";

export const LEAD_TRANSITIONS: Record<LeadState, readonly LeadState[]> = {
  New: ["Enriched", "Disqualified", "DoNotContact"],
  Enriched: ["QueuedForApproval", "Disqualified", "DoNotContact"],
  QueuedForApproval: ["Contacted", "Enriched", "DoNotContact"],
  Contacted: [
    "Contacted",
    "Replied",
    "DiscoveryBooked",
    "DoNotContact",
    "Disqualified",
  ],
  Replied: [
    "DiscoveryBooked",
    "Contacted",
    "QueuedForApproval",
    "DoNotContact",
    "Disqualified",
  ],
  DiscoveryBooked: [],
  Disqualified: [],
  DoNotContact: [],
} as const;

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .replace(/:\d+$/, "");
}
