import Link from "next/link";
import { Card, Empty, Forbidden, PageHeader } from "@/components/ui";
import { fmtDate, fmtInt } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listAudit } from "@/server/services/users";

export const metadata = { title: "Audit Logs · Simple Virtual Shield" };
const PAGE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string; action?: string }>;
}) {
  const ctx = await pageAuth();
  if (!can(ctx.role, "audit:read")) return <Forbidden />;
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
  const action = sp.action && /^[A-Z_]{1,60}$/.test(sp.action) ? sp.action : undefined;
  const { items, total } = await listAudit(ctx, { action, limit: PAGE, offset });
  const q = (o: number) => `/audit?offset=${o}${action ? `&action=${action}` : ""}`;
  return (
    <div className="stack">
      <PageHeader
        title="Audit logs"
        description="Append-only record of uploads, processing, configuration changes, downloads and administrative actions."
      />
      <form method="get" className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="action">Action</label>
          <input
            id="action"
            name="action"
            type="text"
            defaultValue={action}
            placeholder="e.g. OUTPUT_DOWNLOADED"
          />
        </div>
        <button className="btn">Filter</button>
      </form>
      <Card>
        {items.length === 0 ? (
          <Empty>No audit events.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Details</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{fmtDate(e.createdAt)}</td>
                    <td className="mono">{e.action}</td>
                    <td className="small mono">{e.actorUserId?.slice(0, 8) ?? "system"}</td>
                    <td className="small">
                      {e.targetType} <span className="mono">{e.targetId?.slice(0, 8)}</span>
                    </td>
                    <td className="small mono" style={{ maxWidth: 420, wordBreak: "break-word" }}>
                      {JSON.stringify(e.metadata)}
                    </td>
                    <td className="small mono">{e.requestId?.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
          <span className="small muted">{fmtInt(total)} events</span>
          <div className="row">
            {offset > 0 && (
              <Link className="btn btn-sm" href={q(Math.max(0, offset - PAGE))}>
                Newer
              </Link>
            )}
            {offset + PAGE < total && (
              <Link className="btn btn-sm" href={q(offset + PAGE)}>
                Older
              </Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
