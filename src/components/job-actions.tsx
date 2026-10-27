"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";

/** Refresh the server-rendered page while a job is running. */
export function JobPoller({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

export function RetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="row">
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("Retry this job? Any partial results are discarded and recomputed.")) return;
          setBusy(true);
          try {
            await api(`/api/v1/jobs/${jobId}/retry`, { method: "POST" });
            router.refresh();
          } catch (e) {
            setErr(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Retry job
      </button>
      {err && (
        <span className="small" style={{ color: "var(--bad)" }}>
          {err}
        </span>
      )}
    </span>
  );
}
