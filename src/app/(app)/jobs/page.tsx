import Link from "next/link";
import { JobPoller } from "@/components/job-actions";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { fmtDate, fmtInt } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listJobs } from "@/server/services/jobs";

export const metadata = { title: "Processing Jobs · Simple Virtual Shield" };
const PAGE = 25;

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string; status?: string }>;
}) {
  const ctx = await pageAuth();
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
  const status = ["QUEUED", "PARSING", "CLASSIFYING", "EXPORTING", "COMPLETED", "FAILED"].includes(
    sp.status ?? "",
  )
    ? sp.status
    : undefined;
  const { items, total } = await listJobs(ctx, { status, limit: PAGE, offset });
  const running = items.some((j) => !["COMPLETED", "FAILED"].includes(j.status));
  return (
    <div className="stack">
      <JobPoller active={running} />
      <PageHeader
        title="Processing jobs"
        actions={
          can(ctx.role, "job:create") && (
            <Link className="btn btn-primary" href="/upload">
              New job
            </Link>
          )
        }
      />
      <nav className="row small" aria-label="Filter by status">
        {["ALL", "COMPLETED", "FAILED", "QUEUED"].map((s) => (
          <Link
            key={s}
            href={s === "ALL" ? "/jobs" : `/jobs?status=${s}`}
            aria-current={(status ?? "ALL") === s ? "page" : undefined}
          >
            {s.toLowerCase()}
          </Link>
        ))}
      </nav>
      <Card>
        {items.length === 0 ? (
          <Empty>No processing jobs{status ? ` with status ${status.toLowerCase()}` : ""}.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Store</th>
                  <th>Status</th>
                  <th className="num">Progress</th>
                  <th className="num">Rows</th>
                  <th className="num">Unique EPCs</th>
                  <th>Profile</th>
                  <th>Created</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {items.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">
                      <Link href={`/jobs/${j.id}`}>{j.id.slice(0, 8)}</Link>
                    </td>
                    <td>{j.store.name}</td>
                    <td>
                      <Badge value={j.status} />
                    </td>
                    <td className="num">{j.progress}%</td>
                    <td className="num">{fmtInt(j.rowsProcessed)}</td>
                    <td className="num">{j.status === "COMPLETED" ? fmtInt(j.uniqueEpcCount) : "—"}</td>
                    <td className="small">
                      {j.profile.name} v{j.profile.version}
                    </td>
                    <td className="small">{fmtDate(j.createdAt)}</td>
                    <td className="small">{fmtDate(j.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
          <span className="small muted">{fmtInt(total)} jobs</span>
          <div className="row">
            {offset > 0 && (
              <Link
                className="btn btn-sm"
                href={`/jobs?offset=${Math.max(0, offset - PAGE)}${status ? `&status=${status}` : ""}`}
              >
                Previous
              </Link>
            )}
            {offset + PAGE < total && (
              <Link
                className="btn btn-sm"
                href={`/jobs?offset=${offset + PAGE}${status ? `&status=${status}` : ""}`}
              >
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
