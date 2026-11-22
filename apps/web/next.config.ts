import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-bde/schemas",
    "@ai-bde/orchestrator",
    "@ai-bde/agents",
    "@ai-bde/ingest-discover",
  ],
};

export default nextConfig;
