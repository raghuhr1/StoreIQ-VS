"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";
import { fmtBytes, fmtInt, humanize } from "@/lib/format";

type Field =
  | "epc"
  | "zone"
  | "session"
  | "timestamp"
  | "rssi"
  | "readCount"
  | "phase"
  | "readerId"
  | "antennaId"
  | "channel"
  | "txPower"
  | "anchorFlag";
const FIELDS: { key: Field; label: string; required?: boolean }[] = [
  { key: "epc", label: "EPC / RFID tag ID", required: true },
  { key: "zone", label: "Zone (combined files)" },
  { key: "session", label: "Scan session" },
  { key: "timestamp", label: "Timestamp" },
  { key: "rssi", label: "RSSI (dBm)" },
  { key: "readCount", label: "Read count" },
  { key: "readerId", label: "Reader ID" },
  { key: "antennaId", label: "Antenna ID" },
  { key: "phase", label: "Phase (recorded, not used)" },
  { key: "channel", label: "Channel" },
  { key: "txPower", label: "Transmit power" },
  { key: "anchorFlag", label: "Anchor-tag indicator" },
];
const DATE_FORMATS = ["AUTO", "ISO", "MDY", "DMY", "EPOCH_S", "EPOCH_MS"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

interface Zone {
  id: string;
  code: string;
  name: string;
}
interface Store {
  id: string;
  name: string;
  code: string;
  zones: Zone[];
}
interface Profile {
  id: string;
  name: string;
  version: number;
  isDefault: boolean;
}

interface Preview {
  headers: string[];
  headerWarnings: string[];
  sampleRows: string[][];
  malformed: { rowNumber: number; message: string }[];
  suggestion: { mapping: Partial<Record<Field, string>>; scores: Partial<Record<Field, number>> };
  matchingProfiles: {
    id: string;
    name: string;
    mapping: Partial<Record<Field, string>>;
    zoneValueMap: Record<string, string>;
    dateFormat: DateFormat;
  }[];
}

interface Validation {
  ok: boolean;
  mapping: { errors: string[]; warnings: string[] };
  totalRows: number;
  validRows: number;
  invalidRows: number;
  uniqueEpcCount: number;
  issueCounts: Record<string, number>;
  sampleIssues: { rowNumber: number; code: string; message: string; severity: string }[];
  zoneValues: { value: string; count: number; resolvedZoneId: string | null }[];
  preview: {
    rowNumber: number;
    epc: string;
    epcValid: boolean;
    zone?: string;
    session: string;
    timestamp: string | null;
    rssi: number | null;
    readCount: number | null;
  }[];
}

interface Entry {
  key: number;
  file: File | null;
  zoneId: string; // "" => combined file with a zone column
  sessionLabel: string;
  uploadId?: string;
  duplicateOf?: { originalFilename: string } | null;
  preview?: Preview;
  mapping: Partial<Record<Field, string>>;
  zoneValueMap: Record<string, string>;
  dateFormat: DateFormat;
  validation?: Validation;
  error?: string;
}

const STEPS = ["Select store", "Upload files", "Map columns", "Validate", "Start processing"];

export function UploadWizard({
  stores,
  profiles,
  canSaveMapping,
}: {
  stores: Store[];
  profiles: Profile[];
  canSaveMapping: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const store = stores.find((s) => s.id === storeId);
  const nextKey = useRef(1);
  // Created on the first submit and reused for retries, so a double-click or network retry cannot create two jobs.
  const idempotencyKey = useRef<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState(profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "");
  const [saveName, setSaveName] = useState("");

  const blank = (zoneId: string): Entry => ({
    key: nextKey.current++,
    file: null,
    zoneId,
    sessionLabel: "",
    mapping: {},
    zoneValueMap: {},
    dateFormat: "AUTO",
  });
  const update = (key: number, patch: Partial<Entry>) =>
    setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  function chooseStore() {
    if (!store) return;
    const sf = store.zones.find((z) => z.code === "SALES_FLOOR");
    const br = store.zones.find((z) => z.code === "BACK_ROOM");
    setEntries([blank(sf?.id ?? store.zones[0]?.id ?? ""), blank(br?.id ?? store.zones[1]?.id ?? "")]);
    setStep(1);
  }

  async function uploadAll() {
    setError(null);
    const todo = entries.filter((e) => e.file);
    if (todo.length === 0) return setError("Choose at least one CSV file.");
    for (const e of todo) {
      if (e.uploadId) continue;
      setBusy(`Uploading ${e.file!.name}…`);
      try {
        const q = new URLSearchParams({
          storeId,
          filename: e.file!.name,
          ...(e.zoneId ? { zoneId: e.zoneId } : {}),
          ...(e.sessionLabel ? { sessionLabel: e.sessionLabel } : {}),
        });
        const r = await api<{ upload: { id: string }; duplicateOf: { originalFilename: string } | null }>(
          `/api/v1/uploads?${q}`,
          {
            method: "POST",
            body: e.file!,
            headers: { "content-type": "text/csv" },
          },
        );
        const p = await api<Preview>(`/api/v1/uploads/${r.data.upload.id}/preview`);
        const saved = p.data.matchingProfiles[0];
        update(e.key, {
          uploadId: r.data.upload.id,
          duplicateOf: r.data.duplicateOf,
          preview: p.data,
          mapping: saved ? saved.mapping : p.data.suggestion.mapping,
          zoneValueMap: saved?.zoneValueMap ?? {},
          dateFormat: saved?.dateFormat ?? "AUTO",
          error: undefined,
        });
      } catch (err) {
        update(e.key, { error: errorText(err) });
        setBusy(null);
        return;
      }
    }
    setEntries((es) => es.filter((e) => e.file));
    setBusy(null);
    setStep(2);
  }

  async function validateAll() {
    setError(null);
    for (const e of entries) {
      setBusy(`Validating ${e.file?.name}…`);
      try {
        const r = await api<Validation>(`/api/v1/uploads/${e.uploadId}/validate`, {
          method: "POST",
          json: { mapping: clean(e.mapping), zoneValueMap: e.zoneValueMap, dateFormat: e.dateFormat },
        });
        update(e.key, { validation: r.data, error: undefined });
      } catch (err) {
        update(e.key, { error: errorText(err), validation: undefined });
      }
    }
    setBusy(null);
    setStep(3);
  }

  async function saveMapping(e: Entry) {
    if (!saveName.trim()) return setError("Enter a name for the mapping profile.");
    try {
      await api("/api/v1/mapping-profiles", {
        method: "POST",
        json: {
          name: saveName.trim(),
          storeId,
          mapping: clean(e.mapping),
          zoneValueMap: e.zoneValueMap,
          dateFormat: e.dateFormat,
        },
      });
      setError(null);
      setSaveName("");
      setBusy(null);
      alertOk(`Saved mapping profile "${saveName.trim()}".`);
    } catch (err) {
      setError(errorText(err));
    }
  }
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const alertOk = (m: string) => setOkMsg(m);

  async function start() {
    setBusy("Creating job…");
    setError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const r = await api<{ id: string }>("/api/v1/jobs", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey.current },
        json: {
          storeId,
          processingProfileId: profileId || undefined,
          inputs: entries.map((e) => ({
            uploadId: e.uploadId,
            mapping: clean(e.mapping),
            zoneValueMap: e.zoneValueMap,
            dateFormat: e.dateFormat,
          })),
        },
      });
      router.push(`/jobs/${r.data.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  }

  const allValid = entries.length > 0 && entries.every((e) => e.validation?.ok);
  const zoneName = useMemo(
    () => new Map(store?.zones.map((z) => [z.id, `${z.name} (${z.code})`]) ?? []),
    [store],
  );

  if (stores.length === 0)
    return <div className="card empty">Create a store in Store Configuration before uploading scans.</div>;

  return (
    <div className="stack">
      <ol className="steps" aria-label="Upload steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className={i < step ? "done" : undefined}
          >
            {i + 1}. {s}
          </li>
        ))}
        <li>6. Review results</li>
        <li>7. Download outputs</li>
      </ol>
      {error && (
        <div className="alert alert-bad" role="alert">
          {error}
        </div>
      )}
      {okMsg && (
        <div className="alert alert-ok" role="status">
          {okMsg}
        </div>
      )}
      {busy && (
        <div className="alert alert-info" role="status" aria-live="polite">
          {busy}
        </div>
      )}

      {step === 0 && (
        <section className="card stack">
          <h2>1. Select store</h2>
          <div className="field" style={{ maxWidth: 400 }}>
            <label htmlFor="store">Store</label>
            <select id="store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <button className="btn btn-primary" onClick={chooseStore}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 1 && store && (
        <section className="card stack">
          <h2>2. Upload scan exports</h2>
          <p className="muted">
            Export scans from the handheld app exactly as you do today. Upload one file per zone, or a single
            combined file that has a zone column. CSV (UTF-8, with or without BOM; comma, semicolon or tab
            separated).
          </p>
          {entries.map((e, i) => (
            <div key={e.key} className="card stack" style={{ background: "var(--surface-2)" }}>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field">
                  <label htmlFor={`file-${e.key}`}>File {i + 1}</label>
                  <input
                    id={`file-${e.key}`}
                    type="file"
                    accept=".csv,.txt,text/csv"
                    onChange={(ev) =>
                      update(e.key, { file: ev.target.files?.[0] ?? null, uploadId: undefined })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`zone-${e.key}`}>Zone</label>
                  <select
                    id={`zone-${e.key}`}
                    value={e.zoneId}
                    onChange={(ev) => update(e.key, { zoneId: ev.target.value })}
                    disabled={!!e.uploadId}
                  >
                    <option value="">Combined file (zone column)</option>
                    {store.zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        Whole file: {z.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`session-${e.key}`}>Scan session label</label>
                  <input
                    id={`session-${e.key}`}
                    type="text"
                    placeholder="Defaults to file name"
                    value={e.sessionLabel}
                    maxLength={120}
                    onChange={(ev) => update(e.key, { sessionLabel: ev.target.value })}
                    disabled={!!e.uploadId}
                  />
                </div>
                {entries.length > 1 && !e.uploadId && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setEntries((es) => es.filter((x) => x.key !== e.key))}
                  >
                    Remove
                  </button>
                )}
              </div>
              {e.file && (
                <span className="small muted">
                  {e.file.name} · {fmtBytes(e.file.size)} {e.uploadId && "· uploaded"}
                </span>
              )}
              {e.error && (
                <div className="alert alert-bad" role="alert">
                  {e.error}
                </div>
              )}
            </div>
          ))}
          <div className="row">
            <button className="btn btn-sm" onClick={() => setEntries((es) => [...es, blank("")])}>
              Add another file
            </button>
            <button className="btn btn-sm" onClick={() => setEntries([blank("")])}>
              Use one combined file instead
            </button>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setStep(0)}>
              Back
            </button>
            <button className="btn btn-primary" onClick={uploadAll} disabled={!!busy}>
              Upload and preview
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="stack">
          {entries.map((e) => (
            <div key={e.key} className="card stack">
              <h2>3. Map columns — {e.file?.name}</h2>
              <p className="small muted">
                {e.zoneId
                  ? `Whole file assigned to ${zoneName.get(e.zoneId)}.`
                  : "Combined file: map the zone column."}
              </p>
              {e.duplicateOf && (
                <div className="alert alert-warn">
                  This file is identical to a previous upload ({e.duplicateOf.originalFilename}). Do not
                  include both in one job.
                </div>
              )}
              {e.preview?.headerWarnings.map((w) => (
                <div key={w} className="alert alert-warn">
                  {w}
                </div>
              ))}
              {e.preview && e.preview.matchingProfiles.length > 0 && (
                <div className="field" style={{ maxWidth: 360 }}>
                  <label htmlFor={`prof-${e.key}`}>Apply saved mapping</label>
                  <select
                    id={`prof-${e.key}`}
                    defaultValue={e.preview.matchingProfiles[0].id}
                    onChange={(ev) => {
                      const p = e.preview!.matchingProfiles.find((x) => x.id === ev.target.value);
                      update(
                        e.key,
                        p
                          ? { mapping: p.mapping, zoneValueMap: p.zoneValueMap, dateFormat: p.dateFormat }
                          : { mapping: e.preview!.suggestion.mapping },
                      );
                    }}
                  >
                    {e.preview.matchingProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value="">Automatic suggestion</option>
                  </select>
                </div>
              )}
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                {FIELDS.map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={`map-${e.key}-${f.key}`}>
                      {f.label} {f.required && <span aria-hidden>*</span>}
                    </label>
                    <select
                      id={`map-${e.key}-${f.key}`}
                      value={e.mapping[f.key] ?? ""}
                      aria-invalid={f.required && !e.mapping[f.key] ? true : undefined}
                      onChange={(ev) =>
                        update(e.key, {
                          mapping: { ...e.mapping, [f.key]: ev.target.value || undefined },
                          validation: undefined,
                        })
                      }
                    >
                      <option value="">— Not in file / ignore —</option>
                      {e.preview?.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {e.preview?.suggestion.scores[f.key] !== undefined &&
                      e.preview.suggestion.mapping[f.key] === e.mapping[f.key] && (
                        <span className="hint">
                          Suggested ({Math.round((e.preview.suggestion.scores[f.key] ?? 0) * 100)}% match)
                        </span>
                      )}
                  </div>
                ))}
                <div className="field">
                  <label htmlFor={`df-${e.key}`}>Date format</label>
                  <select
                    id={`df-${e.key}`}
                    value={e.dateFormat}
                    onChange={(ev) => update(e.key, { dateFormat: ev.target.value as DateFormat })}
                  >
                    {DATE_FORMATS.map((d) => (
                      <option key={d} value={d}>
                        {d === "AUTO" ? "Automatic (unambiguous only)" : d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {e.preview && (
                <div className="table-wrap">
                  <table>
                    <caption className="sr-only">Sample rows</caption>
                    <thead>
                      <tr>
                        {e.preview.headers.map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {e.preview.sampleRows.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          {r.map((c, j) => (
                            <td key={j} className="mono">
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canSaveMapping && (
                <div className="row" style={{ alignItems: "flex-end" }}>
                  <div className="field">
                    <label htmlFor={`save-${e.key}`}>Save this mapping for future exports</label>
                    <input
                      id={`save-${e.key}`}
                      type="text"
                      placeholder="e.g. RFD40 inventory export"
                      value={saveName}
                      onChange={(ev) => setSaveName(ev.target.value)}
                      maxLength={80}
                    />
                  </div>
                  <button className="btn btn-sm" onClick={() => saveMapping(e)}>
                    Save mapping profile
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="row">
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn btn-primary"
              onClick={validateAll}
              disabled={!!busy || entries.some((e) => !e.mapping.epc)}
            >
              Validate all rows
            </button>
          </div>
        </section>
      )}

      {step === 3 && store && (
        <section className="stack">
          {entries.map((e) => {
            const v = e.validation;
            return (
              <div key={e.key} className="card stack">
                <h2>4. Validation — {e.file?.name}</h2>
                {e.error && (
                  <div className="alert alert-bad" role="alert">
                    {e.error}
                  </div>
                )}
                {v && (
                  <>
                    {v.mapping.errors.map((m) => (
                      <div key={m} className="alert alert-bad" role="alert">
                        {m}
                      </div>
                    ))}
                    {v.mapping.warnings.map((m) => (
                      <div key={m} className="alert alert-warn">
                        {m}
                      </div>
                    ))}
                    <div className="grid grid-stats">
                      <div className="stat">
                        <div className="stat-label">Rows</div>
                        <div className="stat-value">{fmtInt(v.totalRows)}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Valid rows</div>
                        <div className="stat-value">{fmtInt(v.validRows)}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Invalid rows</div>
                        <div className="stat-value">{fmtInt(v.invalidRows)}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Unique EPCs</div>
                        <div className="stat-value">{fmtInt(v.uniqueEpcCount)}</div>
                      </div>
                    </div>
                    {Object.keys(v.issueCounts).length > 0 && (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Issue</th>
                              <th className="num">Rows</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(v.issueCounts).map(([code, n]) => (
                              <tr key={code}>
                                <td>{humanize(code)}</td>
                                <td className="num">{fmtInt(n)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {v.sampleIssues.length > 0 && (
                      <details>
                        <summary>First {v.sampleIssues.length} row issues</summary>
                        <ul className="small">
                          {v.sampleIssues.map((i, k) => (
                            <li key={k}>
                              Row {i.rowNumber}: <strong>{i.severity}</strong> {i.message}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {e.mapping.zone && v.zoneValues.length > 0 && (
                      <div className="stack">
                        <h3>Zone values in this file</h3>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Value in file</th>
                                <th className="num">Rows</th>
                                <th>Maps to zone</th>
                              </tr>
                            </thead>
                            <tbody>
                              {v.zoneValues.map((z) => (
                                <tr key={z.value}>
                                  <td className="mono">{z.value || "(empty)"}</td>
                                  <td className="num">{fmtInt(z.count)}</td>
                                  <td>
                                    <label className="sr-only" htmlFor={`zv-${e.key}-${z.value}`}>
                                      Zone for {z.value}
                                    </label>
                                    <select
                                      id={`zv-${e.key}-${z.value}`}
                                      value={e.zoneValueMap[z.value] ?? z.resolvedZoneId ?? ""}
                                      aria-invalid={
                                        !z.resolvedZoneId && !e.zoneValueMap[z.value] ? true : undefined
                                      }
                                      onChange={(ev) => {
                                        const m = { ...e.zoneValueMap };
                                        if (ev.target.value) m[z.value] = ev.target.value;
                                        else delete m[z.value];
                                        update(e.key, { zoneValueMap: m });
                                      }}
                                    >
                                      <option value="">Unknown — rows will be rejected</option>
                                      {store.zones.map((zz) => (
                                        <option key={zz.id} value={zz.id}>
                                          {zz.name}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {v.preview.length > 0 && (
                      <details>
                        <summary>Mapped row preview</summary>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Row</th>
                                <th>EPC</th>
                                <th>Zone</th>
                                <th>Session</th>
                                <th>Timestamp (UTC)</th>
                                <th className="num">RSSI</th>
                                <th className="num">Reads</th>
                              </tr>
                            </thead>
                            <tbody>
                              {v.preview.map((p) => (
                                <tr key={p.rowNumber}>
                                  <td>{p.rowNumber}</td>
                                  <td className="mono">
                                    {p.epc}{" "}
                                    {!p.epcValid && <span className="badge badge-warn">malformed</span>}
                                  </td>
                                  <td>{p.zone}</td>
                                  <td>{p.session}</td>
                                  <td>{p.timestamp ?? "—"}</td>
                                  <td className="num">{p.rssi ?? "—"}</td>
                                  <td className="num">{p.readCount ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                    {v.ok ? (
                      <div className="alert alert-ok">Ready to process.</div>
                    ) : (
                      <div className="alert alert-bad">Fix the mapping or zone values before processing.</div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          <div className="row">
            <button className="btn" onClick={() => setStep(2)}>
              Back to mapping
            </button>
            <button className="btn" onClick={validateAll} disabled={!!busy}>
              Re-validate
            </button>
            <button className="btn btn-primary" onClick={() => setStep(4)} disabled={!allValid}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="card stack">
          <h2>5. Start processing</h2>
          <div className="field" style={{ maxWidth: 400 }}>
            <label htmlFor="profile">Processing profile</label>
            <select id="profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} v{p.version}
                  {p.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">
              The default profile favours review over exclusion when evidence is insufficient.
            </span>
          </div>
          <ul>
            {entries.map((e) => (
              <li key={e.key}>
                {e.file?.name}: {fmtInt(e.validation?.validRows)} valid rows,{" "}
                {e.zoneId ? zoneName.get(e.zoneId) : "combined zones"}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn" onClick={() => setStep(3)}>
              Back
            </button>
            <button className="btn btn-primary" onClick={start} disabled={!!busy}>
              Start processing
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function clean(m: Partial<Record<Field, string>>) {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v)) as Partial<Record<Field, string>>;
}
