import {
  JobBoardSignalSchema,
  type DiscoverSourceKind,
  type JobBoardSignal,
} from "@ai-bde/schemas";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pluggable hiring-signal fetcher.
 * - fixture (default): local JSON sample job board
 * - rss: allowlisted Atom/RSS URLs (public job feeds)
 * - job_board_api: allowlisted HTTP JSON endpoints
 *
 * No LinkedIn scrape. Rate-limited for live fetchers.
 */

export interface FetcherContext {
  /** Absolute or relative path to fixture JSON */
  fixturePath?: string;
  /** Allowlisted feed/API URLs (comma-separated env or explicit) */
  allowlistUrls?: string[];
  /** Min ms between live HTTP calls */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface FetchResult {
  sourceKind: DiscoverSourceKind;
  signals: JobBoardSignal[];
  skipped?: string;
}

let lastLiveFetchAt = 0;

/** Default RSS/API allowlist — empty until operators add public feeds. */
export const DISCOVER_FEED_ALLOWLIST: string[] = (
  process.env.DISCOVER_FEED_ALLOWLIST ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function createFetcher(
  kind: DiscoverSourceKind = "fixture",
): (ctx?: FetcherContext) => Promise<FetchResult> {
  switch (kind) {
    case "fixture":
      return fetchFixtureSignals;
    case "rss":
      return fetchRssSignals;
    case "job_board_api":
      return fetchJobBoardApiSignals;
    default:
      return fetchFixtureSignals;
  }
}

export async function fetchFixtureSignals(
  ctx: FetcherContext = {},
): Promise<FetchResult> {
  const fixturePath =
    ctx.fixturePath ??
    process.env.DISCOVER_FIXTURE_PATH ??
    path.resolve(__dirname, "../fixtures/job-signals.json");

  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Fixture must be a JSON array of job signals");
  }

  const nowIso = (ctx.now ?? (() => new Date))().toISOString();
  const signals: JobBoardSignal[] = [];
  for (const row of raw) {
    const withTime =
      typeof row === "object" && row !== null
        ? {
            ...(row as Record<string, unknown>),
            source: {
              ...((row as { source?: Record<string, unknown> }).source ?? {}),
              retrieved_at:
                (row as { source?: { retrieved_at?: string } }).source
                  ?.retrieved_at ?? nowIso,
            },
          }
        : row;
    const parsed = JobBoardSignalSchema.safeParse(withTime);
    if (!parsed.success) {
      console.warn(
        "[ingest-discover] skip invalid fixture row:",
        parsed.error.message,
      );
      continue;
    }
    signals.push(parsed.data);
  }

  return { sourceKind: "fixture", signals };
}

async function assertAllowlisted(
  url: string,
  allowlist: string[],
): Promise<void> {
  if (!allowlist.length) {
    throw new Error(
      "DISCOVER_FEED_ALLOWLIST is empty — add public feed URLs before live fetch",
    );
  }
  const ok = allowlist.some(
    (allowed) => url === allowed || url.startsWith(allowed),
  );
  if (!ok) {
    throw new Error(`URL not on DISCOVER_FEED_ALLOWLIST: ${url}`);
  }
}

function rateLimit(minIntervalMs: number): void {
  const now = Date.now();
  if (now - lastLiveFetchAt < minIntervalMs) {
    throw new Error(
      `Rate limited: wait ${minIntervalMs - (now - lastLiveFetchAt)}ms`,
    );
  }
  lastLiveFetchAt = now;
}

/**
 * Minimal RSS/Atom item extractor for public job feeds.
 * Expects <item> or <entry> with title/link/description.
 */
export async function fetchRssSignals(
  ctx: FetcherContext = {},
): Promise<FetchResult> {
  const allowlist = ctx.allowlistUrls?.length
    ? ctx.allowlistUrls
    : DISCOVER_FEED_ALLOWLIST;
  const feedUrl = process.env.DISCOVER_RSS_URL?.trim();
  if (!feedUrl) {
    return {
      sourceKind: "rss",
      signals: [],
      skipped: "DISCOVER_RSS_URL unset — using no live items",
    };
  }

  await assertAllowlisted(feedUrl, allowlist);
  rateLimit(ctx.minIntervalMs ?? 5000);

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const res = await fetchImpl(feedUrl, {
    headers: {
      "User-Agent": "ai-bde-discover/0.1",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed: HTTP ${res.status}`);
  }
  const xml = await res.text();
  const nowIso = (ctx.now ?? (() => new Date))().toISOString();
  const items = parseRssItems(xml).slice(0, 50);
  const signals: JobBoardSignal[] = [];

  for (const item of items) {
    const domain = guessDomainFromText(`${item.title} ${item.description}`);
    if (!domain) continue;
    const candidate = {
      external_id: `rss:${hashId(item.link ?? item.title)}`,
      company: item.company ?? domain.split(".")[0]!,
      domain,
      job_title: item.title,
      job_url: item.link,
      description: item.description,
      tech_hints: [],
      source: {
        type: "job_post" as const,
        url: item.link,
        title: item.title,
        retrieved_at: nowIso,
        snippet: item.description?.slice(0, 240),
      },
    };
    const parsed = JobBoardSignalSchema.safeParse(candidate);
    if (parsed.success) signals.push(parsed.data);
  }

  return { sourceKind: "rss", signals };
}

/**
 * JSON job-board API: expects `{ jobs: JobBoardSignal[] }` or `JobBoardSignal[]`.
 */
export async function fetchJobBoardApiSignals(
  ctx: FetcherContext = {},
): Promise<FetchResult> {
  const allowlist = ctx.allowlistUrls?.length
    ? ctx.allowlistUrls
    : DISCOVER_FEED_ALLOWLIST;
  const apiUrl = process.env.DISCOVER_API_URL?.trim();
  if (!apiUrl) {
    return {
      sourceKind: "job_board_api",
      signals: [],
      skipped: "DISCOVER_API_URL unset — using no live items",
    };
  }

  await assertAllowlisted(apiUrl, allowlist);
  rateLimit(ctx.minIntervalMs ?? 5000);

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const res = await fetchImpl(apiUrl, {
    headers: {
      "User-Agent": "ai-bde-discover/0.1",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Job board API failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { jobs?: unknown }).jobs)
      ? (body as { jobs: unknown[] }).jobs
      : [];

  const signals: JobBoardSignal[] = [];
  for (const row of rows) {
    const parsed = JobBoardSignalSchema.safeParse(row);
    if (parsed.success) signals.push(parsed.data);
  }
  return { sourceKind: "job_board_api", signals };
}

function parseRssItems(xml: string): Array<{
  title: string;
  link?: string;
  description?: string;
  company?: string;
}> {
  const chunks =
    xml.match(/<item[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry[\s\S]*?<\/entry>/gi) ??
    [];
  return chunks.map((chunk) => {
    const title = textTag(chunk, "title") ?? "Untitled role";
    const link =
      textTag(chunk, "link") ??
      chunk.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
    const description =
      textTag(chunk, "description") ?? textTag(chunk, "summary") ?? undefined;
    return { title: stripCdata(title), link, description: description ? stripCdata(description) : undefined };
  });
}

function textTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim() ?? null;
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/i, "").replace(/\]\]>$/i, "").trim();
}

function guessDomainFromText(text: string): string | null {
  const m = text.match(
    /\b([a-z0-9][a-z0-9-]*\.(?:com|io|dev|co|ai|app|health|care))\b/i,
  );
  return m?.[1]?.toLowerCase() ?? null;
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}
