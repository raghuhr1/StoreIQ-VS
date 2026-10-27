import Link from "next/link";
import { Badge, Card, Empty, NeedsGroundTruth, PageHeader, Stat } from "@/components/ui";
import { fmtDate, fmtInt, fmtPct } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { dashboard } from "@/server/services/dashboard";

export const metadata = { title: "Dashboard · Simple Virtual Shield" };

interface EvalMetrics {
  overall?: { recall: number | null; falseAcceptanceRate: number | null };
  labeledCount?: number;
}

export default async function DashboardPage() {
  const ctx = await pageAuth();
  const d = await dashboard(ctx);
  const canUpload = can(ctx.role, "upload:write");
  return (
    <div className="stack">
      <PageHeader
        title="Dashboard"
        description="Scan normally. Clean virtually. Trust your inventory."
        actions={
          canUpload && (
            <Link className="btn btn-primary" href="/upload">
              Upload scans
            </Link>
          )
        }
      />
      <div className="grid grid-stats">
        <Stat label="Stores" value={fmtInt(d.storeCount)} />
        <Stat
          label="Files awaiting processing"
          value={fmtInt(d.pendingUploads)}
          note="Uploaded, not yet in a job"
        />
        <Stat label="Jobs in progress" value={fmtInt(d.jobs.inProgress)} />
        <Stat label="Completed jobs" value={fmtInt(d.jobs.completed)} />
        <Stat label="Failed jobs" value={fmtInt(d.jobs.failed)} />
        <Stat
          label="Unique EPCs processed"
          value={fmtInt(d.totalUniqueEpcsProcessed)}
          note="Sum over completed jobs"
        />
      </div>

      {d.storeCount === 0 ? (
        <Card>
          <Empty>
            No stores yet.{" "}
            {can(ctx.role, "store:write") ? (
              <Link href="/stores">Create your first store</Link>
            ) : (
              "Ask a manager to create a store."
            )}
          </Empty>
        </Card>
      ) : (
        <Card title="Latest results by store">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Last completed job</th>
                  <th>Accepted by zone</th>
                  <th className="num">Needs review</th>
                  <th className="num">Excluded cross-reads</th>
                  <th className="num">Multi-zone overlap</th>
                </tr>
              </thead>
              <tbody>
                {d.latestByStore.map(({ store, job }) => (
                  <tr key={store.id}>
                    <td>{store.name}</td>
                    {job ? (
                      <>
                        <td>
                          <Link href={`/jobs/${job.id}`}>{fmtDate(job.completedAt)}</Link>
                        </td>
                        <td>
                          {Object.entries(job.metrics.acceptedByZone ?? {}).map(([z, n]) => (
                            <div key={z}>
                              <span className="mono">{z}</span>: {fmtInt(n)}
                            </div>
                          ))}
                        </td>
                        <td className="num">{fmtInt(job.metrics.reviewCount)}</td>
                        <td className="num">{fmtInt(job.metrics.rejectedFromZoneCount)}</td>
                        <td className="num">{fmtPct(job.metrics.multiZoneOverlapRate)}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="muted">
                        No completed jobs yet
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid grid-2">
        <Card
          title="Recent processing jobs"
          actions={
            <Link href="/jobs" className="small">
              All jobs
            </Link>
          }
        >
          {d.recentJobs.length === 0 ? (
            <Empty>No jobs yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Store</th>
                    <th>Status</th>
                    <th className="num">Unique EPCs</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentJobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Link href={`/jobs/${j.id}`}>{fmtDate(j.createdAt)}</Link>
                      </td>
                      <td>{j.store}</td>
                      <td>
                        <Badge value={j.status} />
                      </td>
                      <td className="num">
                        {j.status === "COMPLETED" ? fmtInt(j.uniqueEpcCount) : `${j.progress}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Evaluation against ground truth">
          {d.evaluations.length === 0 ? (
            <p>
              Genuine-item recall and cross-zone false acceptance: <NeedsGroundTruth />. Upload a physically
              verified label set in <Link href="/reports">Reports</Link> to evaluate a job.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th className="num">Labeled EPCs</th>
                    <th className="num">Recall</th>
                    <th className="num">False acceptance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.evaluations.map((e) => {
                    const m = e.metrics as EvalMetrics;
                    return (
                      <tr key={e.id}>
                        <td>
                          <Link href={`/reports?jobId=${e.jobId}`}>{e.dataset}</Link>
                        </td>
                        <td className="num">{fmtInt(m.labeledCount)}</td>
                        <td className="num">{fmtPct(m.overall?.recall)}</td>
                        <td className="num">{fmtPct(m.overall?.falseAcceptanceRate)}</td>
                        <td>{e.inSample && <Badge value="IN-SAMPLE" tone="warn" />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            Scores are heuristic evidence scores, not calibrated probabilities. Accuracy is only reported
            against labeled ground truth.
          </p>
        </Card>
      </div>
    </div>
  );
}
