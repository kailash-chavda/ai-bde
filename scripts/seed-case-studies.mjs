/**
 * Seed approved portfolio case studies into Postgres.
 *
 * Facts only from https://kailash-chavda.github.io/#projects
 * (see scripts/data/portfolio-case-studies.json). Idempotent on slug.
 *
 * Usage:
 *   docker compose up -d
 *   npm run db:migrate
 *   npm run seed:case-studies
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataPath = path.join(__dirname, "data", "portfolio-case-studies.json");

function loadEnvFile() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://aibde:aibde@localhost:5432/aibde";
const embeddingProvider = process.env.EMBEDDING_PROVIDER ?? "stub";

function assertSeedRow(row, index) {
  const required = [
    "slug",
    "title",
    "service_pillars",
    "tech_tags",
    "summary",
    "source_url",
  ];
  for (const key of required) {
    if (row[key] == null || (Array.isArray(row[key]) && !row[key].length)) {
      throw new Error(`Seed row ${index}: missing ${key}`);
    }
  }
  if (!Array.isArray(row.outcomes)) {
    throw new Error(`Seed row ${index} (${row.slug}): outcomes must be an array`);
  }
  for (const o of row.outcomes) {
    if (o.verified !== true) {
      throw new Error(
        `Seed row ${index} (${row.slug}): outcomes must be verified:true only`,
      );
    }
  }
  if (row.client_name) {
    throw new Error(
      `Seed row ${index} (${row.slug}): client_name must be null (no invented clients)`,
    );
  }
}

async function main() {
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Seed data not found: ${dataPath}`);
  }

  const studies = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  if (!Array.isArray(studies) || !studies.length) {
    throw new Error("Seed data must be a non-empty array");
  }
  studies.forEach(assertSeedRow);

  console.log(`database: ${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`seed file: ${dataPath}`);
  console.log(`rows: ${studies.length}`);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows: cols } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'case_studies' AND column_name = 'source_url'
    `);
    if (!cols.length) {
      throw new Error(
        'case_studies.source_url missing — run `npm run db:migrate` first (expects 002_case_study_source_url.sql)',
      );
    }

    let inserted = 0;
    let updated = 0;

    await client.query("BEGIN");
    try {
      for (const study of studies) {
        const outcomes = JSON.stringify(study.outcomes ?? []);
        const industries = study.industries ?? [];
        const embeddingStatus =
          embeddingProvider === "stub" ? "ready" : "pending";

        const { rows } = await client.query(
          `
          INSERT INTO case_studies (
            slug, title, service_pillars, industries, tech_tags, summary,
            outcomes, client_name, anonymized_label, source_url,
            approved, approved_at, embedding_status, updated_at
          ) VALUES (
            $1, $2, $3::service_pillar[], $4, $5, $6,
            $7::jsonb, NULL, $8, $9,
            true, now(), $10, now()
          )
          ON CONFLICT (slug) DO UPDATE SET
            title = EXCLUDED.title,
            service_pillars = EXCLUDED.service_pillars,
            industries = EXCLUDED.industries,
            tech_tags = EXCLUDED.tech_tags,
            summary = EXCLUDED.summary,
            outcomes = EXCLUDED.outcomes,
            client_name = NULL,
            anonymized_label = EXCLUDED.anonymized_label,
            source_url = EXCLUDED.source_url,
            approved = true,
            approved_at = COALESCE(case_studies.approved_at, now()),
            embedding_status = EXCLUDED.embedding_status,
            archived_at = NULL,
            updated_at = now()
          RETURNING id, (xmax = 0) AS was_insert
          `,
          [
            study.slug,
            study.title,
            study.service_pillars,
            industries,
            study.tech_tags,
            study.summary,
            outcomes,
            study.anonymized_label ?? null,
            study.source_url,
            embeddingStatus,
          ],
        );

        const row = rows[0];
        if (row.was_insert) inserted += 1;
        else updated += 1;

        // Embed stub audit trail (same agent as approveCaseStudy)
        await client.query(
          `INSERT INTO agent_runs (lead_id, agent, input_hash, output, model, status)
           VALUES (NULL, 'embed_case_study', $1, $2::jsonb, $3, 'success')`,
          [
            createHash("sha256").update(String(row.id)).digest("hex"),
            JSON.stringify({
              case_study_id: row.id,
              slug: study.slug,
              embedding_status: embeddingStatus,
              note: "seed:case-studies Phase 1 stub embed",
              source_url: study.source_url,
            }),
            embeddingProvider,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const { rows: approved } = await client.query(
      `SELECT count(*)::int AS n FROM case_studies
       WHERE approved = true AND archived_at IS NULL`,
    );

    console.log(
      `seed complete: inserted=${inserted} updated=${updated} approved_total=${approved[0].n}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
