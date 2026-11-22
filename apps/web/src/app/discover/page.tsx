import { DiscoverQueue } from "@/components/DiscoverQueue";
import { listDiscoverCandidates } from "@/lib/discover";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  let items: Awaited<ReturnType<typeof listDiscoverCandidates>> = [];
  let error: string | null = null;

  try {
    items = await listDiscoverCandidates("pending");
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : "Database unavailable — migrate 004_phase2b_discover.sql";
  }

  return (
    <>
      <h1>Discover</h1>
      <p className="lede">
        Job-board / RSS hiring signals for mobile and full-stack roles. Review
        candidates, then promote into the lead pipeline. First send stays on
        HITL — no LinkedIn scrape, no invented emails.
      </p>
      {error ? <div className="flash error">{error}</div> : null}
      <DiscoverQueue
        initialItems={items.map((r) => ({
          id: r.id,
          company: r.company,
          domain: r.domain,
          job_title: r.job_title,
          job_url: r.job_url,
          location: r.location,
          geography: r.geography,
          tech_hints: r.tech_hints ?? [],
          confidence_score: r.confidence_score,
          sources: (r.sources as DiscoverQueueSources) ?? [],
          website_enrichment: r.website_enrichment,
          decision_maker_hint: r.decision_maker_hint,
          hiring_signals: (r.hiring_signals as DiscoverQueueHiring) ?? [],
        }))}
      />
    </>
  );
}

type DiscoverQueueSources = Array<{
  type?: string;
  url?: string;
  title?: string;
  snippet?: string;
}>;
type DiscoverQueueHiring = Array<{ title?: string; signals?: string[] }>;
