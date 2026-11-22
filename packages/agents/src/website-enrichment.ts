import {
  normalizeDomain,
  type SourceRef,
  type WebsiteEnrichment,
} from "@ai-bde/schemas";

/**
 * Company-website enrichment hook for Research / Discover.
 * Default: fixture snippets for known sample domains + optional HTTP fetch
 * for allowlisted hosts only. Never scrapes LinkedIn.
 */

/** Domains permitted for live HTTP enrichment (extend carefully). */
export const WEBSITE_ENRICH_ALLOWLIST = new Set([
  "example.com",
  "example.org",
  // Local fixture companies (no live fetch required — see FIXTURE_WEBSITES)
  "northwindhealth.com",
  "rivermobile.io",
  "stackforge.dev",
  "carepathapps.com",
  "orbitcommerce.com",
]);

const FIXTURE_WEBSITES: Record<
  string,
  { tech_hints: string[]; snippets: string[] }
> = {
  "northwindhealth.com": {
    tech_hints: ["react native", "hipaa", "fhir"],
    snippets: [
      "Northwind Health builds patient engagement apps for clinics.",
      "Stack highlights: React Native, FHIR integrations.",
    ],
  },
  "rivermobile.io": {
    tech_hints: ["flutter", "ios", "android"],
    snippets: [
      "River Mobile ships cross-platform consumer apps.",
      "Hiring to expand Flutter and native bridge work.",
    ],
  },
  "stackforge.dev": {
    tech_hints: ["next.js", "node", "react", "saas"],
    snippets: [
      "Stackforge is a B2B SaaS platform for engineering ops.",
      "Public careers page mentions Next.js and Node services.",
    ],
  },
  "carepathapps.com": {
    tech_hints: ["react native", "hipaa", "medtech"],
    snippets: [
      "CarePath Apps focuses on MedTech mobile experiences.",
      "Compliance-minded React Native delivery.",
    ],
  },
  "orbitcommerce.com": {
    tech_hints: ["shopify", "react", "node", "ecommerce"],
    snippets: [
      "Orbit Commerce builds headless ecommerce storefronts.",
      "React + Node storefronts with Shopify backends.",
    ],
  },
};

export interface WebsiteEnrichOptions {
  /** Force fixture-only (no HTTP). Default true for local/dev safety. */
  fixtureOnly?: boolean;
  /** Milliseconds between outbound HTTP enrich calls (rate limit). */
  minIntervalMs?: number;
  /** Optional fetch override for tests */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

let lastHttpEnrichAt = 0;

function rateLimitOk(minIntervalMs: number, nowMs: number): boolean {
  if (nowMs - lastHttpEnrichAt < minIntervalMs) return false;
  lastHttpEnrichAt = nowMs;
  return true;
}

/**
 * Enrich from company website signals. Prefer fixtures; HTTP only when
 * fixtureOnly=false AND domain is on WEBSITE_ENRICH_ALLOWLIST.
 */
export async function enrichFromCompanyWebsite(
  rawDomain: string,
  options: WebsiteEnrichOptions = {},
): Promise<WebsiteEnrichment> {
  const domain = normalizeDomain(rawDomain);
  const now = (options.now ?? (() => new Date))().toISOString();
  const fixtureOnly = options.fixtureOnly ?? true;
  const minIntervalMs = options.minIntervalMs ?? 2000;

  const fixture = FIXTURE_WEBSITES[domain];
  if (fixture) {
    const source: SourceRef = {
      type: "website",
      url: `https://${domain}/`,
      title: `${domain} (fixture website)`,
      retrieved_at: now,
      snippet: fixture.snippets[0],
    };
    return {
      domain,
      fetched: true,
      tech_hints: fixture.tech_hints,
      snippets: fixture.snippets,
      sources: [source],
    };
  }

  if (fixtureOnly) {
    return {
      domain,
      fetched: false,
      tech_hints: [],
      snippets: [],
      sources: [],
      skipped_reason: "fixture_only_mode",
    };
  }

  if (!WEBSITE_ENRICH_ALLOWLIST.has(domain)) {
    return {
      domain,
      fetched: false,
      tech_hints: [],
      snippets: [],
      sources: [],
      skipped_reason: `domain_not_allowlisted:${domain}`,
    };
  }

  const nowMs = Date.now();
  if (!rateLimitOk(minIntervalMs, nowMs)) {
    return {
      domain,
      fetched: false,
      tech_hints: [],
      snippets: [],
      sources: [],
      skipped_reason: "rate_limited",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      method: "GET",
      headers: {
        "User-Agent": "ai-bde-discover/0.1 (+https://github.com/kailash-chavda/ai-bde)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        domain,
        fetched: false,
        tech_hints: [],
        snippets: [],
        sources: [],
        skipped_reason: `http_${res.status}`,
      };
    }
    const html = (await res.text()).slice(0, 50_000);
    const tech_hints = detectTechFromHtml(html);
    const snippet = extractMetaDescription(html) ?? undefined;
    const source: SourceRef = {
      type: "website",
      url: `https://${domain}/`,
      title: `${domain} homepage`,
      retrieved_at: now,
      snippet,
    };
    return {
      domain,
      fetched: true,
      tech_hints,
      snippets: snippet ? [snippet] : [],
      sources: [source],
    };
  } catch (err) {
    return {
      domain,
      fetched: false,
      tech_hints: [],
      snippets: [],
      sources: [],
      skipped_reason:
        err instanceof Error ? err.message.slice(0, 200) : "fetch_failed",
    };
  }
}

function detectTechFromHtml(html: string): string[] {
  const lower = html.toLowerCase();
  const found: string[] = [];
  const map: Array<[string, string[]]> = [
    ["react native", ["react native", "react-native"]],
    ["flutter", ["flutter"]],
    ["next.js", ["next.js", "nextjs", "_next/"]],
    ["react", ["react"]],
    ["node", ["node.js", "nodejs"]],
    ["laravel", ["laravel"]],
    ["shopify", ["shopify"]],
    ["hipaa", ["hipaa"]],
    ["ios", [" ios ", "swift"]],
    ["android", ["android", "kotlin"]],
  ];
  for (const [label, needles] of map) {
    if (needles.some((n) => lower.includes(n))) found.push(label);
  }
  return found;
}

function extractMetaDescription(html: string): string | null {
  const m =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    );
  return m?.[1]?.trim().slice(0, 280) ?? null;
}
