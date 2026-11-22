import {
  normalizeDomain,
  type HiringSignal,
  type HiringSignalTag,
  type JobBoardSignal,
  type SourceRef,
} from "@ai-bde/schemas";

const MOBILE_NEEDLES = [
  "ios",
  "android",
  "swift",
  "kotlin",
  "flutter",
  "react native",
  "mobile engineer",
  "mobile developer",
];

const FULLSTACK_NEEDLES = [
  "full stack",
  "full-stack",
  "fullstack",
  "next.js",
  "node.js",
  "react engineer",
  "software engineer",
];

const CONTRACT_NEEDLES = [
  "contract",
  "contractor",
  "freelance",
  "agency",
  "c2c",
  "corp-to-corp",
];

/**
 * Classify mobile / full-stack hiring tags from job title + description.
 * Only returns tags with textual evidence — no invented emails or contacts.
 */
export function classifyHiringSignals(input: {
  title: string;
  description?: string;
  source: SourceRef;
}): HiringSignal {
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();
  const signals: HiringSignalTag[] = [];

  if (MOBILE_NEEDLES.some((n) => text.includes(n))) {
    signals.push("mobile_hiring");
  }
  if (FULLSTACK_NEEDLES.some((n) => text.includes(n))) {
    signals.push("fullstack_hiring");
  }
  if (CONTRACT_NEEDLES.some((n) => text.includes(n))) {
    signals.push("contract_or_agency_language");
  }
  if (/\b(backfill|replacement|maternity cover)\b/.test(text)) {
    signals.push("backfill");
  }
  if (signals.length === 0 || /bottleneck|capacity|bandwidth|stretch/.test(text)) {
    if (/bottleneck|capacity|bandwidth|stretch|overwhelm|backlog/.test(text)) {
      signals.push("engineering_bottleneck");
    }
  }
  // Open eng roles imply capacity pressure for agency ICP
  if (signals.includes("mobile_hiring") || signals.includes("fullstack_hiring")) {
    if (!signals.includes("engineering_bottleneck")) {
      signals.push("engineering_bottleneck");
    }
  }

  return {
    title: input.title.trim(),
    url: input.source.url,
    posted_at: undefined,
    signals: [...new Set(signals)],
    source: input.source,
  };
}

/** Score 0..1 from signal quality (sources present; no invented contact). */
export function scoreDiscoverConfidence(input: {
  hiring: HiringSignal;
  techHints: string[];
  websiteFetched: boolean;
  hasPublicContact: boolean;
}): number {
  let score = 0.25;
  if (input.hiring.signals.includes("mobile_hiring")) score += 0.2;
  if (input.hiring.signals.includes("fullstack_hiring")) score += 0.15;
  if (input.hiring.signals.includes("contract_or_agency_language")) score += 0.1;
  if (input.techHints.length) score += 0.1;
  if (input.websiteFetched) score += 0.1;
  if (input.hasPublicContact) score += 0.1;
  if (input.hiring.url) score += 0.05;
  return Math.min(1, Math.round(score * 1000) / 1000);
}

export function isMobileOrFullstackSignal(hiring: HiringSignal): boolean {
  return (
    hiring.signals.includes("mobile_hiring") ||
    hiring.signals.includes("fullstack_hiring")
  );
}

export function normalizeJobBoardSignal(
  raw: JobBoardSignal,
): JobBoardSignal {
  return {
    ...raw,
    domain: normalizeDomain(raw.domain),
    company: raw.company.trim(),
    job_title: raw.job_title.trim(),
    tech_hints: raw.tech_hints ?? [],
  };
}
