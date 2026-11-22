"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SequenceControls(props: {
  leadId: string;
  status: string | null;
  pauseReason: string | null;
  resumable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "pause" | "resume") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${props.leadId}/sequence/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "user:local-dev" }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const active = props.status === "active";
  const paused = props.status === "paused";

  return (
    <div className="sequence-controls" style={{ marginBottom: "1.5rem" }}>
      <div className="actions">
        {active ? (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act("pause")}
          >
            Pause sequence
          </button>
        ) : null}
        {paused && props.resumable ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act("resume")}
          >
            Resume sequence
          </button>
        ) : null}
        {paused && !props.resumable ? (
          <span className="badge">
            Not resumable ({props.pauseReason ?? "terminal"})
          </span>
        ) : null}
        {!active && !paused ? (
          <span className="badge">Sequence {props.status ?? "none"}</span>
        ) : null}
      </div>
      {error ? <p className="flash error">{error}</p> : null}
    </div>
  );
}
