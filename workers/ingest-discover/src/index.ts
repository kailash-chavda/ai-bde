import pg from "pg";
import { runDiscoverIngest } from "./ingest.js";
import type { DiscoverSourceKind } from "@ai-bde/schemas";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://aibde:aibde@localhost:5432/aibde";

function parseKind(raw?: string): DiscoverSourceKind {
  if (raw === "rss" || raw === "job_board_api" || raw === "fixture") return raw;
  return "fixture";
}

async function main() {
  const sourceKind = parseKind(
    process.env.DISCOVER_SOURCE_KIND ?? process.argv[2],
  );
  const fixtureOnlyWebsite =
    (process.env.DISCOVER_WEBSITE_HTTP ?? "0") !== "1";

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const summary = await runDiscoverIngest(pool, {
      sourceKind,
      fixtureOnlyWebsite,
    });
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
