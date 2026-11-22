"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const PILLARS = [
  "mobile_native",
  "mobile_cross_platform",
  "web_saas",
  "healthcare_medtech",
  "ecommerce",
  "erp",
] as const;

export function CaseStudyForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const pillar = String(fd.get("pillar") ?? "");
    const sourceUrl = String(fd.get("source_url") ?? "").trim();
    const payload = {
      slug: String(fd.get("slug") ?? ""),
      title: String(fd.get("title") ?? ""),
      service_pillars: [pillar],
      industries: String(fd.get("industries") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      tech_tags: String(fd.get("tech_tags") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      summary: String(fd.get("summary") ?? ""),
      outcomes: [] as [],
      client_name: null,
      anonymized_label: String(fd.get("anonymized_label") ?? "") || null,
      source_url: sourceUrl || null,
    };

    try {
      const res = await fetch("/api/case-studies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string; id?: string };
      if (!res.ok) {
        setError(data.error ?? "Create failed");
        return;
      }
      setMessage(`Created ${data.id} (unapproved; outcomes empty until approve)`);
      e.currentTarget.reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form item" onSubmit={(ev) => void onSubmit(ev)}>
      <h2 style={{ margin: 0 }}>Create case study</h2>
      {message ? <div className="flash">{message}</div> : null}
      {error ? <div className="flash error">{error}</div> : null}
      <label>
        Slug
        <input name="slug" pattern="[a-z0-9-]+" required placeholder="hipaa-patient-app" />
      </label>
      <label>
        Title
        <input name="title" required placeholder="HIPAA patient app delivery" />
      </label>
      <label>
        Pillar
        <select name="pillar" required defaultValue="healthcare_medtech">
          {PILLARS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label>
        Anonymized label
        <input name="anonymized_label" placeholder="US MedTech Series B" />
      </label>
      <label>
        Industries (comma-separated)
        <input name="industries" placeholder="healthcare, medtech" />
      </label>
      <label>
        Tech tags (comma-separated)
        <input name="tech_tags" placeholder="React Native, Node.js" />
      </label>
      <label>
        Source URL (portfolio / public proof)
        <input
          name="source_url"
          type="url"
          placeholder="https://kailash-chavda.github.io/#projects"
        />
      </label>
      <label>
        Summary (approved copy only — no invented metrics)
        <textarea name="summary" required rows={4} />
      </label>
      <button className="primary" disabled={busy} type="submit">
        Create (unapproved)
      </button>
    </form>
  );
}
