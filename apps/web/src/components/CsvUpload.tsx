"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ImportResultRow {
  leadId: string;
  deduped: boolean;
  state: string;
  error?: string;
}

interface ImportResponse {
  accepted?: number;
  results?: ImportResultRow[];
  error?: unknown;
}

export function CsvUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportResultRow[] | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    setResults(null);

    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) {
      setError("Choose a CSV file first");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/leads/import", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as ImportResponse;
      if (!res.ok) {
        setError(
          typeof data.error === "string"
            ? data.error
            : "Import failed",
        );
        return;
      }

      const rows = data.results ?? [];
      setResults(rows);
      const ok = rows.filter((r) => !r.error).length;
      const bad = rows.filter((r) => r.error).length;
      setMessage(
        `Accepted ${data.accepted ?? rows.length} row(s): ${ok} ok, ${bad} error(s).`,
      );
      form.reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="item" style={{ marginBottom: "1.5rem" }}>
      <h2 style={{ marginTop: 0 }}>Import CSV</h2>
      <p className="meta" style={{ marginBottom: "0.85rem" }}>
        Headers:{" "}
        <code>
          company,domain,decision_maker,email,role,geography
        </code>{" "}
        (optional:{" "}
        <code>tech,hiring,notes,message,linkedin,employee_band</code>). Posts
        multipart to <code>POST /api/leads/import</code>.
      </p>
      <form className="form" onSubmit={onSubmit} style={{ maxWidth: "28rem" }}>
        <label>
          Source
          <select name="source" defaultValue="csv">
            <option value="csv">CSV</option>
            <option value="sales_navigator">Sales Navigator</option>
          </select>
        </label>
        <label>
          File
          <input name="file" type="file" accept=".csv,text/csv,application/json" />
        </label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Uploading…" : "Upload & ingest"}
          </button>
        </div>
      </form>
      {message ? <div className="flash" style={{ marginTop: "1rem" }}>{message}</div> : null}
      {error ? (
        <div className="flash error" style={{ marginTop: "1rem" }}>
          {error}
        </div>
      ) : null}
      {results?.length ? (
        <table className="table" style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th>Lead</th>
              <th>State</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={`${r.leadId}-${i}`}>
                <td>
                  {r.leadId ? (
                    <a href={`/leads/${r.leadId}`}>
                      {r.leadId.slice(0, 8)}…
                    </a>
                  ) : (
                    "—"
                  )}
                  {r.deduped ? (
                    <div className="meta">deduped</div>
                  ) : null}
                </td>
                <td>
                  <span className="badge">{r.state}</span>
                </td>
                <td className="meta">
                  {r.error ? r.error.slice(0, 160) : "ok"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
