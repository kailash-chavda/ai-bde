import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");

/** Load `.env` into process.env without overriding existing vars (Windows-friendly). */
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

async function main() {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    throw new Error(`No .sql files in ${migrationsDir}`);
  }

  console.log(`database: ${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`migrations dir: ${migrationsDir}`);
  console.log(`files: ${files.join(", ")}`);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE id = $1",
        [file],
      );
      if (rows.length) {
        console.log(`skip ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`apply ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`ok ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    const { rows: tables } = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const names = tables.map((r) => r.tablename);
    console.log(`tables: ${names.join(", ")}`);
    for (const required of [
      "leads",
      "outreach_items",
      "case_studies",
      "inboxes",
      "sequence_templates",
    ]) {
      if (!names.includes(required)) {
        throw new Error(
          `Migration finished but required table "${required}" is missing`,
        );
      }
    }
    console.log("migrations complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
