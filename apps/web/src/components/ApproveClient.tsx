"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ApproveClient({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onApprove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/case-studies/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Approve failed");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void onApprove()}
        type="button"
      >
        Approve → embed
      </button>
      {error ? <span className="meta"> {error}</span> : null}
    </span>
  );
}
