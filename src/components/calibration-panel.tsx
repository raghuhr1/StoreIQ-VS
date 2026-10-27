"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";
import { fmtDate, fmtInt } from "@/lib/format";

interface Dataset {
  id: string;
  name: string;
  purpose: "CALIBRATION" | "GROUND_TRUTH";
  storeId: string;
  jobId: string | null;
  labelCount: number;
  createdAt: string;
  store: { name: string };
}
interface Suggestion {
  zones: {
    zoneCode: string;
    genuineCount: number;
    crossReadCount: number;
    genuineP10: number | null;
    crossReadP90: number | null;
    suggestedWeakRssiThreshold: number | null;
    note: string;
  }[];
  multiZone: {
    labeledCount: number;
    rssiMarginP10: number | null;
    misleadingRssiCount: number;
    note: string;
  };
  sufficient: boolean;
}

export function EvaluateForm({ jobId, datasets }: { jobId: string; datasets: Dataset[] }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gt = datasets.filter((d) => d.purpose === "GROUND_TRUTH");
  if (gt.length === 0)
    return <p className="small muted">Upload a ground-truth dataset for this store to evaluate the job.</p>;
  return (
    <form
      className="row"
      style={{ alignItems: "flex-end" }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api(`/api/v1/jobs/${jobId}/evaluations`, {
            method: "POST",
            json: { datasetId: new FormData(e.currentTarget).get("datasetId") },
          });
          router.refresh();
        } catch (x) {
          setErr(errorText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="eval-ds">Ground-truth dataset</label>
        <select id="eval-ds" name="datasetId">
          {gt.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({fmtInt(d.labelCount)} labels)
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Evaluating…" : "Evaluate job"}
      </button>
      {err && (
        <div className="alert alert-bad" role="alert">
          {err}
        </div>
      )}
    </form>
  );
}

export function DatasetUpload({
  stores,
  jobs,
  canWrite,
}: {
  stores: { id: string; name: string }[];
  jobs: { id: string; label: string; storeId: string }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  if (!canWrite) return null;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const file = f.get("file") as File | null;
        if (!file || file.size === 0) return setMsg({ tone: "bad", text: "Choose a label CSV file." });
        const q = new URLSearchParams({
          storeId,
          name: String(f.get("name")),
          purpose: String(f.get("purpose")),
          ...(f.get("jobId") ? { jobId: String(f.get("jobId")) } : {}),
        });
        setBusy(true);
        try {
          await api(`/api/v1/calibration/datasets?${q}`, {
            method: "POST",
            body: file,
            headers: { "content-type": "text/csv" },
          });
          setMsg({ tone: "ok", text: "Dataset uploaded." });
          form.reset();
          router.refresh();
        } catch (x) {
          setMsg({ tone: "bad", text: errorText(x) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="small muted">
        CSV with columns <code>epc</code>, <code>actual_zone</code> (zone code or name), optional{" "}
        <code>category</code> (KNOWN_LOCATION, BOUNDARY, CROSS_READ_EXAMPLE, AMBIGUOUS) and <code>notes</code>
        . Labels must come from physical verification, never from this system&apos;s output. Use{" "}
        <strong>calibration</strong> datasets to tune thresholds and separate <strong>ground-truth</strong>{" "}
        datasets (ideally from a different scan session or day) to evaluate.
      </p>
      {msg && (
        <div className={`alert alert-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="ds-name">Name</label>
          <input id="ds-name" name="name" type="text" required maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="ds-purpose">Purpose</label>
          <select id="ds-purpose" name="purpose">
            <option value="GROUND_TRUTH">Ground truth (evaluation)</option>
            <option value="CALIBRATION">Calibration (tuning)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ds-store">Store</label>
          <select id="ds-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ds-job">Labels describe job (optional)</label>
          <select id="ds-job" name="jobId">
            <option value="">—</option>
            {jobs
              .filter((j) => j.storeId === storeId)
              .map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ds-file">Label file</label>
          <input id="ds-file" name="file" type="file" accept=".csv,text/csv" required />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Uploading…" : "Upload labels"}
        </button>
      </div>
    </form>
  );
}

export function DatasetList({ datasets }: { datasets: Dataset[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [s, setS] = useState<Suggestion | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (datasets.length === 0) return <p className="muted">No labeled datasets yet.</p>;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Purpose</th>
              <th>Store</th>
              <th className="num">Labels</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.purpose === "GROUND_TRUTH" ? "Ground truth" : "Calibration"}</td>
                <td>{d.store.name}</td>
                <td className="num">{fmtInt(d.labelCount)}</td>
                <td className="small">{fmtDate(d.createdAt)}</td>
                <td>
                  {d.purpose === "CALIBRATION" && d.jobId && (
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        setOpen(d.id);
                        setErr(null);
                        setS(null);
                        try {
                          setS(
                            (await api<Suggestion>(`/api/v1/calibration/datasets/${d.id}/suggestions`)).data,
                          );
                        } catch (x) {
                          setErr(errorText(x));
                        }
                      }}
                    >
                      Threshold suggestions
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && err && <div className="alert alert-bad">{err}</div>}
      {open && s && (
        <div className="card stack">
          <h3>Advisory calibration suggestions</h3>
          {!s.sufficient && (
            <div className="alert alert-warn">Not enough labeled examples for reliable suggestions.</div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zone</th>
                  <th className="num">Genuine</th>
                  <th className="num">Cross-read</th>
                  <th className="num">Genuine RSSI p10</th>
                  <th className="num">Cross-read RSSI p90</th>
                  <th className="num">Suggested weak threshold</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {s.zones.map((z) => (
                  <tr key={z.zoneCode}>
                    <td className="mono">{z.zoneCode}</td>
                    <td className="num">{z.genuineCount}</td>
                    <td className="num">{z.crossReadCount}</td>
                    <td className="num">{z.genuineP10 ?? "—"}</td>
                    <td className="num">{z.crossReadP90 ?? "—"}</td>
                    <td className="num">{z.suggestedWeakRssiThreshold ?? "—"}</td>
                    <td className="small">{z.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            Multi-zone: {s.multiZone.note}{" "}
            {s.multiZone.rssiMarginP10 !== null &&
              `10th percentile RSSI margin: ${s.multiZone.rssiMarginP10} dB.`}
          </p>
          <p className="small muted">
            To apply, an administrator saves a new processing profile version in Settings (listing this job
            under &quot;tuned from jobs&quot;) and evaluates it on a different, independently labeled job.
          </p>
        </div>
      )}
    </div>
  );
}
