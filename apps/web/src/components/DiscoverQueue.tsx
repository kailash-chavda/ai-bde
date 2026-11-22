"use client";

import { useState } from "react";

export interface DiscoverItem {
  id: string;
  company: string;
  domain: string;
  job_title: string;
  job_url: string | null;
  location: string | null;
  geography: string | null;
  tech_hints: string[];
  confidence_score: string;
  sources: Array<{ type?: string; url?: string; title?: string; snippet?: string }>;
  website_enrichment: {
    fetched?: boolean;
    tech_hints?: string[];
    snippets?: string[];
    skipped_reason?: string;
  } | null;
  decision_maker_hint: {
    full_name?: string;
    role?: string;
    email?: string;
    linkedin_url?: string;
  } | null;
  hiring_signals: Array<{
    title?: string;
    signals?: string[];
  }>;
}

export function DiscoverQueue({
  initialItems,
}: {
  initialItems: DiscoverItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    role: "CTO",
    linkedin_url: "",
  });

  async function runFetch() {
    setRunning(true);
    setMessage(null);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_kind: "fixture" }),
      });
      const data = (await res.json()) as {
        error?: string;
        upserted?: number;
        skippedFilter?: number;
        fetched?: number;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Ingest failed");
        return;
      }
      const list = await fetch("/api/discover?status=pending");
      const payload = (await list.json()) as { candidates: DiscoverItem[] };
      setItems(payload.candidates ?? []);
      setMessage(
        `Fetched ${data.fetched ?? 0} · upserted ${data.upserted ?? 0} · filtered ${data.skippedFilter ?? 0}`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  function openPromote(item: DiscoverItem) {
    setPromoteId(item.id);
    setForm({
      full_name: item.decision_maker_hint?.full_name ?? "",
      email: item.decision_maker_hint?.email ?? "",
      role: item.decision_maker_hint?.role ?? "CTO",
      linkedin_url: item.decision_maker_hint?.linkedin_url ?? "",
    });
    setMessage(null);
  }

  async function confirmPromote() {
    if (!promoteId) return;
    if (!form.full_name.trim()) {
      setMessage("Full name is required");
      return;
    }
    if (!form.email.trim() && !form.linkedin_url.trim()) {
      setMessage(
        "Provide a real email or LinkedIn URL — the system will not invent contacts",
      );
      return;
    }
    setBusy(promoteId);
    setMessage(null);
    try {
      const res = await fetch(`/api/discover/${promoteId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_maker: {
            full_name: form.full_name.trim(),
            role: form.role.trim() || "CTO",
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            ...(form.linkedin_url.trim()
              ? { linkedin_url: form.linkedin_url.trim() }
              : {}),
          },
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        leadId?: string;
        state?: string;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Promote failed");
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== promoteId));
      setPromoteId(null);
      setMessage(
        `Promoted → lead ${data.leadId?.slice(0, 8)} (${data.state}). First send still needs HITL.`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(id: string) {
    setBusy(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/discover/${id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "not_icp" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMessage(data.error ?? "Dismiss failed");
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      if (promoteId === id) setPromoteId(null);
      setMessage("Dismissed");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="actions" style={{ marginBottom: "0.5rem" }}>
        <button
          className="primary"
          type="button"
          disabled={running}
          onClick={() => void runFetch()}
        >
          {running ? "Fetching…" : "Run fixture discover ingest"}
        </button>
      </div>
      {message ? <div className="flash">{message}</div> : null}

      {!items.length ? (
        <div className="item">
          <p className="meta" style={{ margin: 0 }}>
            No pending Discover candidates. Run fixture ingest above, or{" "}
            <code>npm run discover:ingest</code>.
          </p>
        </div>
      ) : null}

      {items.map((item) => {
        const tags =
          item.hiring_signals?.flatMap((h) => h.signals ?? []) ?? [];
        return (
          <article key={item.id} className="item">
            <h2>
              {item.company}
              <span className="meta" style={{ marginLeft: "0.5rem" }}>
                {item.domain}
              </span>
            </h2>
            <div className="meta">
              {item.job_title}
              {item.job_url ? (
                <>
                  {" · "}
                  <a href={item.job_url} target="_blank" rel="noreferrer">
                    job post
                  </a>
                </>
              ) : null}
              {item.location ? ` · ${item.location}` : ""}
              {" · confidence "}
              {item.confidence_score}
            </div>
            <div className="meta">
              Signals: {tags.length ? tags.join(", ") : "—"}
              {item.tech_hints?.length
                ? ` · tech: ${item.tech_hints.join(", ")}`
                : ""}
            </div>
            {item.website_enrichment?.fetched ? (
              <div className="meta">
                Website enrichment:{" "}
                {(item.website_enrichment.snippets ?? [])[0] ?? "fetched"}
              </div>
            ) : item.website_enrichment?.skipped_reason ? (
              <div className="meta">
                Website: skipped ({item.website_enrichment.skipped_reason})
              </div>
            ) : null}
            <div className="meta">
              Sources:{" "}
              {item.sources
                ?.map((s) => s.type ?? "source")
                .filter(Boolean)
                .join(", ") || "—"}
            </div>

            {promoteId === item.id ? (
              <div className="form" style={{ marginTop: "0.75rem" }}>
                <p className="meta" style={{ margin: 0 }}>
                  Enter a known contact to promote. Emails are never invented —
                  first outreach still requires HITL approve.
                </p>
                <label>
                  Full name
                  <input
                    value={form.full_name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, full_name: e.target.value }))
                    }
                    placeholder="Alex Riv"
                  />
                </label>
                <label>
                  Role
                  <input
                    value={form.role}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, role: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Email (optional if LinkedIn set)
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, email: e.target.value }))
                    }
                    placeholder="alex@company.com"
                  />
                </label>
                <label>
                  LinkedIn URL (optional if email set)
                  <input
                    value={form.linkedin_url}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, linkedin_url: e.target.value }))
                    }
                    placeholder="https://www.linkedin.com/in/…"
                  />
                </label>
                <div className="actions">
                  <button
                    className="primary"
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => void confirmPromote()}
                  >
                    Promote to lead pipeline
                  </button>
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => setPromoteId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => openPromote(item)}
                >
                  Review → promote
                </button>
                <button
                  className="danger"
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void dismiss(item.id)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
