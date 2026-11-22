/**
 * Guard: after `tsc`, Discover runtime exports must exist on dist.
 * Catches stale/partial builds that omit JobBoardSignalSchema etc.
 */
import {
  DiscoverCandidateSchema,
  DiscoverPromoteSchema,
  DiscoverSourceKindSchema,
  DiscoverStatusSchema,
  ENRICHMENT_VERSION_DISCOVER,
  HiringSignalTagSchema,
  JobBoardSignalSchema,
  WebsiteEnrichmentSchema,
} from "../dist/index.js";

const required = {
  JobBoardSignalSchema,
  DiscoverCandidateSchema,
  DiscoverPromoteSchema,
  DiscoverSourceKindSchema,
  DiscoverStatusSchema,
  HiringSignalTagSchema,
  WebsiteEnrichmentSchema,
  ENRICHMENT_VERSION_DISCOVER,
};

const missing = Object.entries(required)
  .filter(([, value]) => value == null)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `@ai-bde/schemas dist missing Discover exports: ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log("ok @ai-bde/schemas Discover exports");
