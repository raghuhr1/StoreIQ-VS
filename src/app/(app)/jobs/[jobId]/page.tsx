import Link from "next/link";
import { notFound } from "next/navigation";
import { JobPoller, RetryButton } from "@/components/job-actions";
import { ResultsExplorer } from "@/components/results-explorer";
import { Alert, Badge, Card, PageHeader, Stat } from "@/components/ui";
import { fmtBytes, fmtDate, fmtInt, fmtPct } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { AppError } from "@/server/errors";
import { getJob } from "@/server/services/jobs";

export const metadata = { title: "Job · Simple Virtual Shield" };

interface Metrics {
  uniqueEpcCount: number;
  acceptedCount: number;
  reviewCount: number;
  rejectedFromZoneCount: number;
  rejectedPrimaryCount: number;
  multiZoneEpcCount: number;
  multiZoneOverlapRate: number | null;
  missingUsefulEvidenceRate: number | null;
  anchorEpcCount: number;
  duplicateObservationCount: number;
  observedByZone: Record<string, number>;
  acceptedByZone: Record<string, number>;
  rejectedFromZoneByZone: Record<string, number>;
  rowStats: { inputFileCount: number; inputRowCount: number; validRowCount: number; invalidRowCount: number };
}

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const ctx = await pageAuth();
  const { jobId } = await params;
  let job;
  try {
    job = await getJob(ctx, jobId);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const running = !["COMPLETED", "FAILED"].includes(job.status);
  const m = job.metrics?.summary as unknown as Metrics | undefined;
  const zones = job.store.zones.map((z) => ({ id: z.id, code: z.code, name: z.name }));
  const warnings = (job.warnings as { code: string; message: string }[]) ?? [];
  const canDownload = can(ctx.role, "results:download");

  return (
    <div className="stack">
      <JobPoller active={running} />
      <PageHeader
        title={`Job ${job.id.slice(0, 8)}`}
        description={
          <>
            {job.store.name} · profile <span className="mono">{job.profileVersion}</span> · created{" "}
            {fmtDate(job.createdAt)}
          </>
        }
        actions={
          <>
            {<Badge value={job.status} />}
            {job.status === "FAILED" && can(ctx.role, "job:create") && <RetryButton jobId={job.id} />}
          </>
        }
      />
      {running && (
        <Card>
          <div className="stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>{job.stage ?? "Waiting for a worker"}</span>
              <span className="small muted">{fmtInt(job.rowsProcessed)} rows processed</span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={job.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Job progress"
            >
              <span style={{ width: `${job.progress}%` }} />
            </div>
          </div>
        </Card>
      )}
      {job.status === "FAILED" && <Alert tone="bad">Processing failed: {job.errorMessage}</Alert>}

      {m && (
        <>
          <div className="grid grid-stats">
            <Stat
              label="Input rows"
              value={fmtInt(m.rowStats.inputRowCount)}
              note={`${fmtInt(m.rowStats.invalidRowCount)} invalid · ${fmtInt(m.duplicateObservationCount)} duplicate`}
            />
            <Stat
              label="Unique EPCs"
              value={fmtInt(m.uniqueEpcCount)}
              note={m.anchorEpcCount ? `${m.anchorEpcCount} anchor tags excluded` : undefined}
            />
            <Stat label="Accepted" value={fmtInt(m.acceptedCount)} />
            <Stat label="Needs review" value={fmtInt(m.reviewCount)} />
            <Stat
              label="Excluded cross-reads"
              value={fmtInt(m.rejectedFromZoneCount)}
              note="EPC excluded from a zone"
            />
            <Stat
              label="Multi-zone EPCs"
              value={fmtInt(m.multiZoneEpcCount)}
              note={`${fmtPct(m.multiZoneOverlapRate)} overlap`}
            />
          </div>
          <Card title="Raw observed vs cleaned inventory">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Zone</th>
                    <th className="num">Observed (raw)</th>
                    <th className="num">Accepted (cleaned)</th>
                    <th className="num">Excluded as cross-read</th>
                  </tr>
                </thead>
                <tbody>
                  {zones.map((z) => (
                    <tr key={z.id}>
                      <td>{z.name}</td>
                      <td className="num">{fmtInt(m.observedByZone[z.code] ?? 0)}</td>
                      <td className="num">{fmtInt(m.acceptedByZone[z.code] ?? 0)}</td>
                      <td className="num">{fmtInt(m.rejectedFromZoneByZone[z.code] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              EPCs needing review are not in any cleaned file and are listed in exceptions. Evidence scores
              are heuristic and uncalibrated; they are not probabilities.
            </p>
          </Card>
        </>
      )}

      {warnings.length > 0 && (
        <Card title="Processing warnings">
          <ul className="small">
            {warnings.map((w, i) => (
              <li key={i}>
                <strong>{w.code.replace(/_/g, " ").toLowerCase()}</strong>: {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {job.status === "COMPLETED" && (
        <Card title="Download outputs">
          {canDownload ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="num">Rows</th>
                    <th className="num">Size</th>
                    <th>Schema</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {job.outputs.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.filename}</td>
                      <td className="num">{fmtInt(o.rowCount)}</td>
                      <td className="num">{fmtBytes(o.sizeBytes)}</td>
                      <td className="small">{o.schemaVersion}</td>
                      <td>
                        <a className="btn btn-sm" href={`/api/v1/jobs/${job.id}/outputs/${o.kind}`} download>
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Your role can view results but not download files.</p>
          )}
        </Card>
      )}

      <div className="grid grid-2">
        <Card title="Inputs">
          <ul className="small">
            {job.inputs.map((i) => (
              <li key={i.uploadId}>
                <span className="mono">{i.upload.originalFilename}</span> · {fmtBytes(i.upload.sizeBytes)} ·{" "}
                {i.upload.zoneId ? zones.find((z) => z.id === i.upload.zoneId)?.name : "combined zones"}
                {i.upload.fileDeletedAt && <Badge value="FILE_DELETED" />}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Scan sessions">
          {job.sessions.length === 0 ? (
            <p className="muted small">Available after parsing.</p>
          ) : (
            <ul className="small">
              {job.sessions.map((s) => (
                <li key={s.id}>
                  <strong>{s.externalId}</strong> ·{" "}
                  {zones.find((z) => z.id === s.zoneId)?.name ?? "mixed zones"} · {fmtInt(s.uniqueEpcCount)}{" "}
                  EPCs ·{" "}
                  {s.startedAt ? `${fmtDate(s.startedAt)} → ${fmtDate(s.endedAt)}` : "timing unavailable"}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {job.status === "COMPLETED" && (
        <Card title="Review results">
          <ResultsExplorer jobId={job.id} zones={zones} />
        </Card>
      )}
      <p className="small">
        <Link href={`/reports?jobId=${job.id}`}>Open report and evaluation for this job</Link>
      </p>
    </div>
  );
}
