"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";

type Role = "ADMIN" | "MANAGER" | "OPERATOR" | "VIEWER";
const ROLES: Role[] = ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"];

export function AddMemberForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string; password?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        setBusy(true);
        try {
          const r = await api<{ email: string; temporaryPassword?: string }>("/api/v1/users", {
            method: "POST",
            json: { email: f.get("email"), name: f.get("name"), role: f.get("role") },
          });
          setMsg(
            r.data.temporaryPassword
              ? {
                  tone: "ok",
                  text: `Account created for ${r.data.email}. Share this temporary password securely; it is shown only once and must be changed at first sign-in:`,
                  password: r.data.temporaryPassword,
                }
              : {
                  tone: "ok",
                  text: `${r.data.email} already had an account and was added to this organization.`,
                },
          );
          form.reset();
          router.refresh();
        } catch (x) {
          setMsg({ tone: "bad", text: errorText(x) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {msg && (
        <div className={`alert alert-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
          {msg.text} {msg.password && <code style={{ userSelect: "all" }}>{msg.password}</code>}
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="m-email">Email</label>
          <input id="m-email" name="email" type="email" required maxLength={254} />
        </div>
        <div className="field">
          <label htmlFor="m-name">Name</label>
          <input id="m-name" name="name" type="text" required maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="m-role">Role</label>
          <select id="m-role" name="role" defaultValue="OPERATOR">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Add user
        </button>
      </div>
    </form>
  );
}

export function MemberActions({
  userId,
  role,
  disabled,
  self,
}: {
  userId: string;
  role: Role;
  disabled: boolean;
  self: boolean;
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      router.refresh();
    } catch (x) {
      setErr(errorText(x));
    }
  };
  return (
    <div className="row">
      <label className="sr-only" htmlFor={`role-${userId}`}>
        Role
      </label>
      <select
        id={`role-${userId}`}
        defaultValue={role}
        onChange={(e) =>
          call(() => api(`/api/v1/users/${userId}`, { method: "PATCH", json: { role: e.target.value } }))
        }
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r.toLowerCase()}
          </option>
        ))}
      </select>
      {!self && (
        <>
          <button
            className="btn btn-sm"
            onClick={() =>
              call(() => api(`/api/v1/users/${userId}`, { method: "PATCH", json: { disabled: !disabled } }))
            }
          >
            {disabled ? "Enable" : "Disable"}
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() =>
              window.confirm("Remove this user from the organization?") &&
              call(() => api(`/api/v1/users/${userId}`, { method: "DELETE" }))
            }
          >
            Remove
          </button>
        </>
      )}
      {err && (
        <span className="small" style={{ color: "var(--bad)" }} role="alert">
          {err}
        </span>
      )}
    </div>
  );
}

interface ProfileConfig {
  epc: {
    malformedPolicy: "FLAG" | "REJECT";
    format: "HEX" | "ANY";
    minLength: number;
    maxLength: number;
    lengthMultipleOf: number;
  };
  duplicates: { policy: "AUTO" | "COLLAPSE" | "COUNT_AS_READS" };
  invalidRows: { maxInvalidRowRatio: number };
  timing: { observationWindowSeconds: number; maxSessionGapHours: number };
  rssi: { marginForFullSupportDb: number; requireSameReader: boolean };
  evidence: {
    minReadsForFullSupport: number;
    minWindowsForFullSupport: number;
    strongDominance: number;
    minReadsForDominance: number;
  };
  weights: { exclusivity: number; persistence: number; rssi: number; anchor: number };
  bands: { high: number; medium: number };
  rules: {
    acceptSingleZoneWithoutSignal: boolean;
    rejectBelowCalibratedThreshold: boolean;
    reviewPossibleMovement: boolean;
  };
  anchors: { enabled: boolean; reliability: number; marginDb: number };
  zoneCalibration: Record<string, { weakRssiThreshold: number | null }>;
  [k: string]: unknown;
}

export function ProfileEditor({
  base,
  zoneCodes,
  canEdit,
}: {
  base: { name: string; version: number; config: ProfileConfig };
  zoneCodes: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [cfg, setCfg] = useState<ProfileConfig>(base.config);
  const [name, setName] = useState(base.name);
  const [notes, setNotes] = useState("");
  const [tuned, setTuned] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const set = <K extends keyof ProfileConfig>(k: K, sub: string, v: unknown) =>
    setCfg((c) => ({ ...c, [k]: { ...(c[k] as object), [sub]: v } }));
  const num = (k: keyof ProfileConfig, sub: string, label: string, step = "1", hint?: string) => (
    <div className="field">
      <label htmlFor={`p-${String(k)}-${sub}`}>{label}</label>
      <input
        id={`p-${String(k)}-${sub}`}
        type="number"
        step={step}
        disabled={!canEdit}
        value={String((cfg[k] as Record<string, unknown>)[sub] ?? "")}
        onChange={(e) => set(k, sub, e.target.value === "" ? null : Number(e.target.value))}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
  const bool = (k: keyof ProfileConfig, sub: string, label: string) => (
    <label style={{ fontWeight: 400 }}>
      <input
        type="checkbox"
        disabled={!canEdit}
        checked={Boolean((cfg[k] as Record<string, unknown>)[sub])}
        onChange={(e) => set(k, sub, e.target.checked)}
      />{" "}
      {label}
    </label>
  );
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        try {
          const r = await api<{ version: number }>("/api/v1/processing-profiles", {
            method: "POST",
            json: {
              name,
              config: cfg,
              notes: notes || undefined,
              isDefault: makeDefault,
              tunedFromJobIds: tuned.split(/[\s,]+/).filter(Boolean),
            },
          });
          setMsg({
            tone: "ok",
            text: `Saved ${name} v${r.data.version}. Existing jobs keep the version they were processed with.`,
          });
          router.refresh();
        } catch (x) {
          setMsg({ tone: "bad", text: errorText(x) });
        }
      }}
    >
      {msg && (
        <div className={`alert alert-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      <h3>Acceptance and evidence</h3>
      <div className="row">
        {num("bands", "high", "Acceptance threshold (evidence score)", "1", "Minimum 70; default 85")}
        {num("bands", "medium", "Medium band from")}
        {num("evidence", "minReadsForFullSupport", "Reads for full persistence")}
        {num("evidence", "minWindowsForFullSupport", "Time windows for full persistence")}
        {num("evidence", "strongDominance", "Strong read dominance (0.5–1)", "0.01")}
        {num("evidence", "minReadsForDominance", "Min reads for dominance")}
      </div>
      <h3>Weights</h3>
      <div className="row">
        {num("weights", "exclusivity", "Zone exclusivity / read share", "0.05")}
        {num("weights", "persistence", "Persistence", "0.05")}
        {num("weights", "rssi", "RSSI margin", "0.05")}
        {num("weights", "anchor", "Anchor evidence", "0.05")}
      </div>
      <h3>Signal and timing</h3>
      <div className="row">
        {num("rssi", "marginForFullSupportDb", "RSSI margin for full support (dB)")}
        {num("timing", "observationWindowSeconds", "Observation window (s)")}
        {num("timing", "maxSessionGapHours", "Max gap between zone scans (h)", "0.25")}
        {num("anchors", "reliability", "Anchor reliability (0–1)", "0.05")}
        {num("invalidRows", "maxInvalidRowRatio", "Max invalid row share (0–1)", "0.05")}
      </div>
      <div className="stack">
        {bool(
          "rules",
          "acceptSingleZoneWithoutSignal",
          "Accept single-zone EPCs by rule when no RSSI, timing or read counts exist (no score)",
        )}
        {bool(
          "rules",
          "reviewPossibleMovement",
          "Review EPCs strongly seen in both zones in sequential scans (possible movement)",
        )}
        {bool(
          "rssi",
          "requireSameReader",
          "Only compare RSSI between zones read by the same reader (or unknown reader)",
        )}
        {bool("anchors", "enabled", "Use registered anchor tags as evidence")}
        {bool(
          "rules",
          "rejectBelowCalibratedThreshold",
          "Exclude single-zone EPCs far below a calibrated zone RSSI threshold (requires calibration)",
        )}
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="p-mal">Malformed EPCs</label>
          <select
            id="p-mal"
            disabled={!canEdit}
            value={cfg.epc.malformedPolicy}
            onChange={(e) => set("epc", "malformedPolicy", e.target.value)}
          >
            <option value="FLAG">Keep and send to review</option>
            <option value="REJECT">Reject the row</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-fmt">EPC format</label>
          <select
            id="p-fmt"
            disabled={!canEdit}
            value={cfg.epc.format}
            onChange={(e) => set("epc", "format", e.target.value)}
          >
            <option value="HEX">Hexadecimal (upper-cased)</option>
            <option value="ANY">Any printable identifier (case preserved)</option>
          </select>
        </div>
        {num("epc", "minLength", "EPC min length")}
        {num("epc", "maxLength", "EPC max length")}
        <div className="field">
          <label htmlFor="p-dup">Identical rows</label>
          <select
            id="p-dup"
            disabled={!canEdit}
            value={cfg.duplicates.policy}
            onChange={(e) => set("duplicates", "policy", e.target.value)}
          >
            <option value="AUTO">Automatic</option>
            <option value="COLLAPSE">Collapse (same record twice)</option>
            <option value="COUNT_AS_READS">Count each as a read</option>
          </select>
        </div>
      </div>
      <h3>Store calibration: weak RSSI threshold per zone (dBm)</h3>
      <div className="row">
        {zoneCodes.map((code) => (
          <div className="field" key={code}>
            <label htmlFor={`cal-${code}`} className="mono">
              {code}
            </label>
            <input
              id={`cal-${code}`}
              type="number"
              step="0.5"
              disabled={!canEdit}
              placeholder="not calibrated"
              value={cfg.zoneCalibration[code]?.weakRssiThreshold ?? ""}
              onChange={(e) =>
                setCfg((c) => ({
                  ...c,
                  zoneCalibration: {
                    ...c.zoneCalibration,
                    [code]: { weakRssiThreshold: e.target.value === "" ? null : Number(e.target.value) },
                  },
                }))
              }
            />
          </div>
        ))}
      </div>
      {canEdit && (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field">
              <label htmlFor="p-name">Profile name</label>
              <input
                id="p-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </div>
            <div className="field" style={{ minWidth: 300 }}>
              <label htmlFor="p-notes">Change notes</label>
              <input
                id="p-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
              />
            </div>
            <div className="field" style={{ minWidth: 300 }}>
              <label htmlFor="p-tuned">Tuned from job IDs (leakage guard)</label>
              <input
                id="p-tuned"
                type="text"
                value={tuned}
                onChange={(e) => setTuned(e.target.value)}
                placeholder="IDs of jobs whose labels informed these values"
              />
            </div>
          </div>
          <label style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />{" "}
            Make this the default profile for new jobs
          </label>
          <div>
            <button className="btn btn-primary">Save as new version</button>
          </div>
        </>
      )}
    </form>
  );
}

export function SetDefaultButton({ profileId }: { profileId: string }) {
  const router = useRouter();
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        await api(`/api/v1/processing-profiles/${profileId}/default`, { method: "POST" });
        router.refresh();
      }}
    >
      Make default
    </button>
  );
}

export function DeleteMappingButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <button
      className="btn btn-sm btn-danger"
      onClick={async () => {
        if (!window.confirm("Delete this mapping profile?")) return;
        await api(`/api/v1/mapping-profiles/${id}`, { method: "DELETE" });
        router.refresh();
      }}
    >
      Delete
    </button>
  );
}
