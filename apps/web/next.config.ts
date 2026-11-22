import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Next only auto-loads `.env*` from `apps/web/`. Repo secrets live in the
 * monorepo root `.env` (see README / `.env.example`). Bridge them here so
 * `DISCORD_WEBHOOK_URL`, `DATABASE_URL`, etc. are visible to API routes.
 * Does not override vars already set in the process environment.
 */
function loadMonorepoRootEnv() {
  const configDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(configDir, "../../.env");
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

loadMonorepoRootEnv();

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-bde/schemas",
    "@ai-bde/orchestrator",
    "@ai-bde/agents",
    "@ai-bde/ingest-discover",
  ],
};

export default nextConfig;
