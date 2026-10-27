"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";

const ZONE_TYPES = ["SALES_FLOOR", "BACK_ROOM", "RECEIVING", "DISPATCH", "FITTING_ROOM", "OTHER"] as const;

function useAction() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: "ok", text: ok });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ tone: "bad", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const note = msg && (
    <div className={`alert alert-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
      {msg.text}
    </div>
  );
  return { run, busy, note };
}

export function CreateStoreForm() {
  const { run, busy, note } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        if (
          await run(
            () =>
              api("/api/v1/stores", {
                method: "POST",
                json: { name: f.get("name"), code: f.get("code"), timeZone: f.get("timeZone") },
              }),
            "Store created with Sales Floor and Back Room zones.",
          )
        )
          form.reset();
      }}
    >
      {note}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="s-name">Store name</label>
          <input id="s-name" name="name" type="text" required maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="s-code">Store code</label>
          <input id="s-code" name="code" type="text" required maxLength={40} pattern="[A-Za-z0-9_\-]+" />
        </div>
        <div className="field">
          <label htmlFor="s-tz">Time zone (IANA)</label>
          <input
            id="s-tz"
            name="timeZone"
            type="text"
            defaultValue={
              typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"
            }
            required
            list="tz-list"
          />
          <datalist id="tz-list">
            {[
              "UTC",
              "Europe/London",
              "America/New_York",
              "America/Chicago",
              "America/Los_Angeles",
              "Asia/Kolkata",
              "Asia/Singapore",
              "Australia/Sydney",
            ].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Create store
        </button>
      </div>
    </form>
  );
}

interface Zone {
  id: string;
  code: string;
  name: string;
  type: string;
  aliases: string[];
  sortOrder: number;
  active: boolean;
}

export function ZoneRow({ storeId, zone, canEdit }: { storeId: string; zone: Zone; canEdit: boolean }) {
  const { run, busy, note } = useAction();
  const [name, setName] = useState(zone.name);
  const [aliases, setAliases] = useState(zone.aliases.join(", "));
  const [active, setActive] = useState(zone.active);
  return (
    <tr>
      <td className="mono">{zone.code}</td>
      <td>
        {canEdit ? (
          <input
            aria-label={`Name of ${zone.code}`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        ) : (
          zone.name
        )}
      </td>
      <td>{zone.type.replace(/_/g, " ").toLowerCase()}</td>
      <td>
        {canEdit ? (
          <input
            aria-label={`Aliases of ${zone.code}`}
            type="text"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="SF, Floor"
          />
        ) : (
          zone.aliases.join(", ")
        )}
      </td>
      <td>
        {canEdit ? (
          <input
            aria-label={`${zone.code} active`}
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : zone.active ? (
          "Yes"
        ) : (
          "No"
        )}
      </td>
      <td>
        {canEdit && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api(`/api/v1/stores/${storeId}/zones/${zone.id}`, {
                    method: "PATCH",
                    json: {
                      name,
                      active,
                      aliases: aliases
                        .split(",")
                        .map((a) => a.trim())
                        .filter(Boolean),
                    },
                  }),
                "Saved",
              )
            }
          >
            Save
          </button>
        )}
        {note}
      </td>
    </tr>
  );
}

export function AddZoneForm({ storeId }: { storeId: string }) {
  const { run, busy, note } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const ok = await run(() =>
          api(`/api/v1/stores/${storeId}/zones`, {
            method: "POST",
            json: {
              code: f.get("code"),
              name: f.get("name"),
              type: f.get("type"),
              sortOrder: Number(f.get("sortOrder") || 10),
              aliases: String(f.get("aliases") ?? "")
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean),
            },
          }),
        );
        if (ok) form.reset();
      }}
    >
      {note}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="z-code">Code</label>
          <input
            id="z-code"
            name="code"
            type="text"
            required
            maxLength={40}
            pattern="[A-Za-z0-9_\-]+"
            placeholder="RECEIVING"
          />
        </div>
        <div className="field">
          <label htmlFor="z-name">Name</label>
          <input id="z-name" name="name" type="text" required maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="z-type">Type</label>
          <select id="z-type" name="type">
            {ZONE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="z-aliases">Aliases in exports</label>
          <input id="z-aliases" name="aliases" type="text" placeholder="RCV, Goods In" />
        </div>
        <div className="field" style={{ minWidth: 90 }}>
          <label htmlFor="z-order">Order</label>
          <input id="z-order" name="sortOrder" type="number" min={0} max={1000} defaultValue={10} />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Add zone
        </button>
      </div>
    </form>
  );
}

export function RelationshipForm({ storeId, zones }: { storeId: string; zones: Zone[] }) {
  const { run, busy, note } = useAction();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(
          () =>
            api(`/api/v1/stores/${storeId}/relationships`, {
              method: "PUT",
              json: { fromZoneId: f.get("from"), toZoneId: f.get("to"), relation: f.get("relation") },
            }),
          "Relationship saved",
        );
      }}
    >
      {note}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="r-from">Zone</label>
          <select id="r-from" name="from">
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-rel">Relationship</label>
          <select id="r-rel" name="relation">
            <option value="ADJACENT">Adjacent</option>
            <option value="DOORWAY">Connected by doorway</option>
            <option value="SHARED_WALL">Shared wall</option>
            <option value="SEPARATED">Physically separated (cross-reads implausible)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-to">Zone</label>
          <select id="r-to" name="to" defaultValue={zones[1]?.id}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" disabled={busy}>
          Save relationship
        </button>
      </div>
    </form>
  );
}

export function AnchorForm({ storeId, zones }: { storeId: string; zones: Zone[] }) {
  const { run, busy, note } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const ok = await run(
          () =>
            api(`/api/v1/stores/${storeId}/anchors`, {
              method: "POST",
              json: {
                epc: f.get("epc"),
                zoneId: f.get("zoneId"),
                description: f.get("description") || undefined,
              },
            }),
          "Anchor registered",
        );
        if (ok) form.reset();
      }}
    >
      {note}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ minWidth: 280 }}>
          <label htmlFor="a-epc">Anchor EPC</label>
          <input id="a-epc" name="epc" type="text" required maxLength={256} className="mono" />
        </div>
        <div className="field">
          <label htmlFor="a-zone">Zone</label>
          <select id="a-zone" name="zoneId">
            {zones
              .filter((z) => z.active)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="a-desc">Installation location</label>
          <input
            id="a-desc"
            name="description"
            type="text"
            maxLength={200}
            placeholder="e.g. Back room door frame, 1.5 m"
          />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Register anchor
        </button>
      </div>
    </form>
  );
}

export function AnchorToggle({
  storeId,
  anchorId,
  active,
}: {
  storeId: string;
  anchorId: string;
  active: boolean;
}) {
  const { run, busy, note } = useAction();
  return (
    <>
      <button
        className={`btn btn-sm${active ? " btn-danger" : ""}`}
        disabled={busy}
        onClick={() => {
          if (
            active &&
            !window.confirm("Deactivate this anchor? It will no longer be used as evidence in new jobs.")
          )
            return;
          void run(() =>
            api(`/api/v1/stores/${storeId}/anchors/${anchorId}`, {
              method: "PATCH",
              json: { active: !active },
            }),
          );
        }}
      >
        {active ? "Deactivate" : "Reactivate"}
      </button>
      {note}
    </>
  );
}
