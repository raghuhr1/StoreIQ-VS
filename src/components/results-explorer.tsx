"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "@/lib/api-client";
import { fmtDate, fmtInt, humanize } from "@/lib/format";

interface Zone {
  id: string;
  code: string;
  name: string;
}
type Tab = "cleaned" | "exceptions" | "observed" | "errors";

interface ResultRow {
  id: string;
  epc: string;
  classification: string;
  assignedZoneId: string | null;
  observedZoneIds: string[];
  confidenceScore: number | null;
  confidenceType: string;
  confidenceBand: string | null;
  reasonCode: string;
  reasonDescription: string;
  recommendedAction: string;
  evidenceAvailable: string[];
  requiresManualReview: boolean;
  evidence: {
    suggestedZoneId?: string | null;
    components?: { name: string; available: boolean; support: number | null; weight: number; note: string }[];
  };
}
interface ObservedRow {
  id: string;
  epc: string;
  zoneId: string;
  rawReadCount: number;
  readCountComplete: boolean;
  windowCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  medianRssi: number | null;
  dataQualityStatus: string;
}
interface ErrorRow {
  id: string;
  rowNumber: number;
  code: string;
  message: string;
  uploadId: string;
}

const LABELS: Record<Tab, string> = {
  cleaned: "Cleaned inventory",
  exceptions: "Exceptions",
  observed: "Observed inventory",
  errors: "Rejected rows",
};
const PAGE = 50;

function tone(c: string) {
  return c === "ACCEPTED" ? "ok" : c === "NEEDS_REVIEW" ? "warn" : "bad";
}

export function ResultsExplorer({
  jobId,
  zones,
  tabs = ["cleaned", "exceptions", "observed", "errors"],
}: {
  jobId: string;
  zones: Zone[];
  tabs?: Tab[];
}) {
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [zoneId, setZoneId] = useState("");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    rows: unknown[];
    total: number;
    byReason: { reasonCode: string; count: number }[];
    error: string | null;
  }>({
    key: "",
    rows: [],
    total: 0,
    byReason: [],
    error: null,
  });
  const [detail, setDetail] = useState<string | null>(null);
  const zc = (id: string | null | undefined) => (id ? (zones.find((z) => z.id === id)?.code ?? id) : "—");

  const path = useMemo(() => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (zoneId) q.set("zoneId", zoneId);
    if (search) q.set("search", search);
    if (tab === "cleaned") {
      q.set("classification", "ACCEPTED");
      return `/api/v1/jobs/${jobId}/results?${q}`;
    }
    if (tab === "exceptions") {
      if (reason) q.set("reasonCode", reason);
      return `/api/v1/jobs/${jobId}/exceptions?${q}`;
    }
    return tab === "observed"
      ? `/api/v1/jobs/${jobId}/observed?${q}`
      : `/api/v1/jobs/${jobId}/row-errors?${q}`;
  }, [jobId, tab, zoneId, reason, search, offset]);

  useEffect(() => {
    let cancelled = false;
    api<unknown[]>(path).then(
      (r) => {
        if (!cancelled)
          setResult((prev) => ({
            key: path,
            rows: r.data,
            total: Number(r.meta?.total ?? 0),
            byReason:
              (r.meta?.byReason as { reasonCode: string; count: number }[] | undefined) ??
              (path.includes("/exceptions") ? [] : prev.byReason),
            error: null,
          }));
      },
      (e) => {
        if (!cancelled)
          setResult((prev) => ({ ...prev, key: path, rows: [], total: 0, error: errorText(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const loading = result.key !== path;
  const { rows, total, byReason, error } = result;

  const switchTab = (t: Tab) => {
    setTab(t);
    setOffset(0);
    setReason("");
  };

  return (
    <div className="stack">
      {tabs.length > 1 && (
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => switchTab(t)}>
              {LABELS[t]}
            </button>
          ))}
        </div>
      )}
      {tab !== "errors" && (
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(String(new FormData(e.currentTarget).get("q") ?? ""));
            setOffset(0);
          }}
        >
          <div className="field">
            <label htmlFor="zone-filter">Zone</label>
            <select
              id="zone-filter"
              value={zoneId}
              onChange={(e) => {
                setZoneId(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All zones</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
          {tab === "exceptions" && byReason.length > 0 && (
            <div className="field">
              <label htmlFor="reason-filter">Reason</label>
              <select
                id="reason-filter"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All reasons</option>
                {byReason.map((r) => (
                  <option key={r.reasonCode} value={r.reasonCode}>
                    {humanize(r.reasonCode)} ({r.count})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="epc-search">EPC contains</label>
            <input id="epc-search" name="q" type="search" defaultValue={search} maxLength={64} />
          </div>
          <button className="btn">Search</button>
        </form>
      )}
      {error && (
        <div className="alert alert-bad" role="alert">
          {error}
        </div>
      )}
      <div className="table-wrap" aria-busy={loading}>
        {tab === "cleaned" || tab === "exceptions" ? (
          <table>
            <thead>
              <tr>
                <th>EPC</th>
                <th>Classification</th>
                <th>Zone(s)</th>
                <th className="num">Evidence score</th>
                <th>Reason</th>
                {tab === "exceptions" && <th>Recommended action</th>}
                <th>Evidence available</th>
              </tr>
            </thead>
            <tbody>
              {(rows as ResultRow[]).map((r) => (
                <tr key={r.id}>
                  <td className="mono">
                    <button
                      className="btn btn-sm"
                      style={{ fontFamily: "inherit" }}
                      onClick={() => setDetail(r.epc)}
                      aria-label={`Details for ${r.epc}`}
                    >
                      {r.epc}
                    </button>
                  </td>
                  <td>
                    <span className={`badge badge-${tone(r.classification)}`}>
                      {r.classification.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td>
                    {r.classification === "ACCEPTED" ? (
                      <strong>{zc(r.assignedZoneId)}</strong>
                    ) : (
                      r.observedZoneIds.map(zc).join(", ")
                    )}
                    {r.classification !== "ACCEPTED" && r.evidence?.suggestedZoneId && (
                      <div className="small muted">leans {zc(r.evidence.suggestedZoneId)}</div>
                    )}
                    {r.classification === "ACCEPTED" && r.observedZoneIds.length > 1 && (
                      <div className="small muted">
                        also seen:{" "}
                        {r.observedZoneIds
                          .filter((z) => z !== r.assignedZoneId)
                          .map(zc)
                          .join(", ")}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {r.confidenceScore === null ? (
                      <span className="small muted">
                        {r.confidenceType === "RULE_BASED_NO_SCORE" ? "rule only" : "not scored"}
                      </span>
                    ) : (
                      r.confidenceScore.toFixed(1)
                    )}
                  </td>
                  <td>
                    <div>{humanize(r.reasonCode)}</div>
                    <div className="small muted">{r.reasonDescription}</div>
                  </td>
                  {tab === "exceptions" && <td className="small">{r.recommendedAction}</td>}
                  <td className="small">{r.evidenceAvailable.map(humanize).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "observed" ? (
          <table>
            <thead>
              <tr>
                <th>EPC</th>
                <th>Observed zone</th>
                <th className="num">Reads</th>
                <th className="num">Windows</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th className="num">Median RSSI</th>
                <th>Data quality</th>
              </tr>
            </thead>
            <tbody>
              {(rows as ObservedRow[]).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.epc}</td>
                  <td>{zc(r.zoneId)}</td>
                  <td className="num">
                    {fmtInt(r.rawReadCount)}
                    {r.readCountComplete ? "" : "+"}
                  </td>
                  <td className="num">{r.windowCount ?? "—"}</td>
                  <td className="small">{fmtDate(r.firstSeen)}</td>
                  <td className="small">{fmtDate(r.lastSeen)}</td>
                  <td className="num">{r.medianRssi ?? "—"}</td>
                  <td>{humanize(r.dataQualityStatus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="num">Row</th>
                <th>Issue</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {(rows as ErrorRow[]).map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.rowNumber}</td>
                  <td>{humanize(r.code)}</td>
                  <td>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && rows.length === 0 && <div className="empty">No records match.</div>}
        {loading && (
          <div className="empty" role="status">
            Loading…
          </div>
        )}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">
          {total === 0
            ? "0 records"
            : `${fmtInt(offset + 1)}–${fmtInt(Math.min(offset + PAGE, total))} of ${fmtInt(total)}`}
          {tab === "observed" && " · reads marked + are lower bounds (read count missing on some rows)"}
        </span>
        <div className="row">
          <button
            className="btn btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </button>
          <button
            className="btn btn-sm"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </button>
        </div>
      </div>
      {detail && <EpcDetail jobId={jobId} epc={detail} zc={zc} onClose={() => setDetail(null)} />}
    </div>
  );
}

interface Trace {
  result: ResultRow & {
    rulesFired: string[];
    zoneDispositions: { zoneId: string; disposition: string; reasonCode: string }[];
  };
  summaries: ObservedRow[];
  observations: {
    id: string;
    uploadId: string;
    rowNumber: number;
    epcRaw: string;
    zoneId: string;
    observedAt: string | null;
    rssi: number | null;
    readCount: number | null;
    duplicate: boolean;
  }[];
}

function EpcDetail({
  jobId,
  epc,
  zc,
  onClose,
}: {
  jobId: string;
  epc: string;
  zc: (id: string | null) => string;
  onClose: () => void;
}) {
  const [t, setT] = useState<Trace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Trace>(`/api/v1/jobs/${jobId}/epcs/${encodeURIComponent(epc)}`).then(
      (r) => setT(r.data),
      (e) => setErr(errorText(e)),
    );
  }, [jobId, epc]);
  return (
    <section className="card stack" aria-label={`Evidence for ${epc}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="mono" style={{ margin: 0 }}>
          {epc}
        </h2>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {err && <div className="alert alert-bad">{err}</div>}
      {t && (
        <>
          <dl className="kv">
            <dt>Classification</dt>
            <dd>
              {t.result.classification.replace(/_/g, " ")}{" "}
              {t.result.assignedZoneId && `→ ${zc(t.result.assignedZoneId)}`}
            </dd>
            <dt>Reason</dt>
            <dd>{t.result.reasonDescription}</dd>
            <dt>Evidence score</dt>
            <dd>
              {t.result.confidenceScore ?? "—"} ({humanize(t.result.confidenceType)}; heuristic, not a
              probability)
            </dd>
            <dt>Rules fired</dt>
            <dd className="mono">{t.result.rulesFired.join(", ")}</dd>
            <dt>Per-zone outcome</dt>
            <dd>
              {t.result.zoneDispositions.map((d) => `${zc(d.zoneId)}: ${humanize(d.disposition)}`).join("; ")}
            </dd>
          </dl>
          {t.result.evidence?.components && t.result.evidence.components.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Evidence component</th>
                    <th>Available</th>
                    <th className="num">Support</th>
                    <th className="num">Weight</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {t.result.evidence.components.map((c) => (
                    <tr key={c.name}>
                      <td>{humanize(c.name)}</td>
                      <td>{c.available ? "Yes" : "No"}</td>
                      <td className="num">{c.support === null ? "—" : c.support.toFixed(2)}</td>
                      <td className="num">{c.weight.toFixed(3)}</td>
                      <td className="small">{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>
            Source rows ({t.observations.length}
            {t.observations.length === 500 ? "+" : ""})
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Original EPC</th>
                  <th>Zone</th>
                  <th>Time (UTC)</th>
                  <th className="num">RSSI</th>
                  <th className="num">Reads</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {t.observations.map((o) => (
                  <tr key={o.id}>
                    <td className="num">{o.rowNumber}</td>
                    <td className="mono">{o.epcRaw}</td>
                    <td>{zc(o.zoneId)}</td>
                    <td className="small">{o.observedAt ?? "—"}</td>
                    <td className="num">{o.rssi ?? "—"}</td>
                    <td className="num">{o.readCount ?? "—"}</td>
                    <td>{o.duplicate && <span className="badge badge-neutral">duplicate</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
