"use client";

import { useState } from "react";

export interface HitlItem {
  id: string;
  lead_id: string;
  company: string;
  subject: string | null;
  body: string;
  matched_case_study_id: string | null;
  case_study_ids: string[];
  created_at: string;
  decision_maker: { full_name?: string; email?: string };
}

export function HitlQueue({
  initialItems,
  bookingLinkBase,
}: {
  initialItems: HitlItem[];
  /** Base Cal.com URL from CALCOM_LINK; lead_id metadata is appended per item. */
  bookingLinkBase?: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function bookingUrl(item: HitlItem): string | null {
    if (!bookingLinkBase) return null;
    try {
      const url = new URL(bookingLinkBase);
      url.searchParams.set("metadata[lead_id]", item.lead_id);
      const email = item.decision_maker?.email;
      const name = item.decision_maker?.full_name;
      if (email) url.searchParams.set("email", email);
      if (name) url.searchParams.set("name", name);
      return url.toString();
    } catch {
      return bookingLinkBase;
    }
  }

  async function act(id: string, action: "approve" | "reject") {
    setBusy(id);
    setMessage(null);
    let reason = "";
    if (action === "reject") {
      reason = window.prompt("Rejection reason (required for rewrite)") ?? "";
      if (!reason.trim()) {
        setBusy(null);
        setMessage("Reject requires a reason");
        return;
      }
    }
    try {
      const res = await fetch(`/api/hitl/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "reject" ? { reason } : { actor: "user:local-dev" },
        ),
      });
      const data = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) {
        setMessage(data.error ?? "Request failed");
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      setMessage(action === "approve" ? "Approved — queued for dispatcher" : "Rejected");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) {
    return (
      <div className="item">
        <p className="meta" style={{ margin: 0 }}>
          No pending drafts. Import leads via{" "}
          <a href="/discover">Discover</a>,{" "}
          <a href="/leads">CSV upload on Leads</a>,{" "}
          <code>POST /api/leads/import</code>, or webhook.
        </p>
        {message ? <p className="flash">{message}</p> : null}
      </div>
    );
  }

  return (
    <div className="stack">
      {message ? <div className="flash">{message}</div> : null}
      {items.map((item) => {
        const calLink = bookingUrl(item);
        return (
          <article key={item.id} className="item">
            <h2>
              {item.company}
              {item.decision_maker?.full_name
                ? ` · ${item.decision_maker.full_name}`
                : ""}
            </h2>
            <div className="meta">
              Subject: {item.subject ?? "—"} · case_study:{" "}
              {item.matched_case_study_id ?? "none"} · lead{" "}
              <a href={`/leads/${item.lead_id}`}>{item.lead_id.slice(0, 8)}</a>
            </div>
            <pre className="draft">{item.body}</pre>
            <div className="actions">
              <button
                className="primary"
                disabled={busy === item.id}
                onClick={() => void act(item.id, "approve")}
                type="button"
              >
                Approve & enqueue send
              </button>
              <button
                className="danger"
                disabled={busy === item.id}
                onClick={() => void act(item.id, "reject")}
                type="button"
              >
                Reject → rewrite
              </button>
              {calLink ? (
                <a
                  className="badge"
                  href={calLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Book discovery
                </a>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
