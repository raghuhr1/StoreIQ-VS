import { DeleteMappingButton, ProfileEditor, SetDefaultButton } from "@/components/admin-forms";
import { PasswordForm } from "@/components/password-form";
import { Badge, Card, PageHeader } from "@/components/ui";
import { fmtBytes, fmtDate, fmtInt } from "@/lib/format";
import { RULES_VERSION, resolveProfile } from "@/engine";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { config } from "@/server/config";
import { listMappingProfiles } from "@/server/services/mappings";
import { listProfiles } from "@/server/services/profiles";
import { listStores } from "@/server/services/stores";

export const metadata = { title: "Settings · Simple Virtual Shield" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ base?: string }> }) {
  const ctx = await pageAuth();
  const [profiles, mappings, stores] = await Promise.all([
    listProfiles(ctx),
    listMappingProfiles(ctx),
    listStores(ctx),
  ]);
  const sp = await searchParams;
  const base = profiles.find((p) => p.id === sp.base) ?? profiles.find((p) => p.isDefault) ?? profiles[0];
  const zoneCodes = [...new Set(stores.flatMap((s) => s.zones.map((z) => z.code)))].sort();
  const c = config();
  const canEditProfiles = can(ctx.role, "profile:write");
  return (
    <div className="stack">
      <PageHeader title="Settings" />
      <Card title="Processing profiles">
        <p className="small muted">
          Profiles are versioned and immutable: saving creates a new version, and every job records the exact
          version and rule set (<span className="mono">{RULES_VERSION}</span>) it used. Thresholds are
          starting points, not accuracy claims; tune them with store calibration data.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profile</th>
                <th>Rules</th>
                <th>Created</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name} v{p.version} {p.isDefault && <Badge value="DEFAULT" tone="ok" />}
                  </td>
                  <td className="mono small">{p.rulesVersion}</td>
                  <td className="small">{fmtDate(p.createdAt)}</td>
                  <td className="small">
                    {p.notes}
                    {p.tunedFromJobIds.length > 0 && ` · tuned from ${p.tunedFromJobIds.length} job(s)`}
                  </td>
                  <td className="row">
                    <a className="btn btn-sm" href={`/settings?base=${p.id}`}>
                      {canEditProfiles ? "Edit as new version" : "View"}
                    </a>
                    {canEditProfiles && !p.isDefault && <SetDefaultButton profileId={p.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {base && (
        <Card
          title={`${canEditProfiles ? "New version based on" : "Configuration of"} ${base.name} v${base.version}`}
        >
          <ProfileEditor
            key={base.id}
            base={{ name: base.name, version: base.version, config: resolveProfile(base.config) as never }}
            zoneCodes={zoneCodes}
            canEdit={canEditProfiles}
          />
        </Card>
      )}
      <Card title="Column mapping profiles">
        {mappings.length === 0 ? (
          <p className="muted">Mapping profiles are saved from the upload wizard.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Export format</th>
                  <th>Mapping</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.exportFormat ?? "—"}</td>
                    <td className="small mono">
                      {Object.entries(m.mapping as Record<string, string>)
                        .map(([k, v]) => `${k}←${v}`)
                        .join(", ")}{" "}
                      · dates {m.dateFormat}
                    </td>
                    <td className="small">{fmtDate(m.updatedAt)}</td>
                    <td>{can(ctx.role, "mapping:write") && <DeleteMappingButton id={m.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid grid-2">
        <Card title="Limits and retention (set by the operator)">
          <dl className="kv">
            <dt>Max upload size</dt>
            <dd>{fmtBytes(c.MAX_UPLOAD_BYTES)}</dd>
            <dt>Max rows per job</dt>
            <dd>{fmtInt(c.MAX_ROWS_PER_JOB)}</dd>
            <dt>Source files kept</dt>
            <dd>
              {c.RETENTION_UPLOAD_FILES_DAYS ? `${c.RETENTION_UPLOAD_FILES_DAYS} days` : "indefinitely"}
            </dd>
            <dt>Raw observations kept</dt>
            <dd>
              {c.RETENTION_RAW_OBSERVATIONS_DAYS
                ? `${c.RETENTION_RAW_OBSERVATIONS_DAYS} days`
                : "indefinitely"}
            </dd>
            <dt>Session lifetime</dt>
            <dd>
              {c.SESSION_TTL_HOURS} h (idle timeout {c.SESSION_IDLE_MINUTES} min)
            </dd>
            <dt>Storage</dt>
            <dd>{c.STORAGE_DRIVER === "s3" ? "Private object storage" : "Local storage (development)"}</dd>
          </dl>
          <p className="small muted">Results, outputs and audit events are kept after source files expire.</p>
        </Card>
        <Card title="Change your password">
          <PasswordForm forced={false} />
        </Card>
      </div>
    </div>
  );
}
