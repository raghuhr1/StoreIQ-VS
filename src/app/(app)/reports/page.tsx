import Link from "next/link";
import { DatasetList, DatasetUpload, EvaluateForm } from "@/components/calibration-panel";
import { JobPicker } from "@/components/job-picker";
import { Alert, Badge, Card, Empty, NeedsGroundTruth, PageHeader } from "@/components/ui";
import { fmtDate, fmtInt, fmtPct, humanize } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listDatasets, listEvaluations } from "@/server/services/calibration";
import { getJob, listJobs } from "@/server/services/jobs";
import { pickCompletedJob } from "@/server/services/job-picker";
import { listStores } from "@/server/services/stores";

export const metadata = { title: "Reports · Simple Virtual Shield" };

interface Metrics {
  uniqueEpcCount: number;
  uncertainRate: number | null;
  classificationCoverage: number | null;
  multiZoneOverlapRate: number | null;
  missingUsefulEvidenceRate: number | null;
  excludedRateByZone: Record<string, number | null>;
  observedByZone: Record<string, number>;
  acceptedByZone: Record<string, number>;
  rejectedFromZoneByZone: Record<string, number>;
  reasonCounts: Record<string, number>;
  confidenceTypeCounts: Record<string, number>;
}
interface ZoneEval {
  groundTruthCount: number;
  recall: number | null;
  precision: number | null;
  falseAcceptanceRate: number | null;
  rawRecall: number | null;
  rawFalseAcceptanceRate: number | null;
  reviewCount: number;
}
interface EvalReport {
  labeledCount: number;
  labeledNotObservedCount: number;
  perZone: Record<string, ZoneEval>;
  overall: { recall: number | null; precision: number | null; falseAcceptanceRate: number | null };
  uncertainRate: number | null;
  classificationCoverage: number | null;
  confusion: { actual: string[]; predicted: string[]; counts: number[][] };
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ jobId?: string }> }) {
  const ctx = await pageAuth();
  const { jobs, selected } = await pickCompletedJob(ctx, (await searchParams).jobId);
  const canCal = can(ctx.role, "calibration:read");
  const job = selected ? await getJob(ctx, selected.id) : null;
  const m = job?.metrics?.summary as unknown as Metrics | undefined;
  const [evaluations, datasets, stores, allJobs] = canCal
    ? await Promise.all([
        job ? listEvaluations(ctx, job.id) : [],
        listDatasets(ctx),
        listStores(ctx),
        listJobs(ctx, { status: "COMPLETED", limit: 100, offset: 0 }),
      ])
    : [[], [], [], { items: [] }];

  return (
    <div className="stack">
      <PageHeader
        title="Reports"
        description="Raw observed vs cleaned inventory, operational indicators and, when labeled data exists, accuracy evaluation."
      />
      {!job || !m ? (
        <Card>
          <Empty>No completed jobs yet.</Empty>
        </Card>
      ) : (
        <>
          <JobPicker jobs={jobs} selectedId={job.id} action="/reports" />
          <Card title={`Operational report — ${job.store.name}, ${fmtDate(job.completedAt)}`}>
            <Alert tone="info">
              These indicators describe the processing outcome. They are not accuracy measures.
            </Alert>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Zone</th>
                    <th className="num">Raw observed EPCs</th>
                    <th className="num">Cleaned (accepted)</th>
                    <th className="num">Excluded from zone</th>
                    <th className="num">% excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {job.store.zones.map((z) => (
                    <tr key={z.id}>
                      <td>{z.name}</td>
                      <td className="num">{fmtInt(m.observedByZone[z.code] ?? 0)}</td>
                      <td className="num">{fmtInt(m.acceptedByZone[z.code] ?? 0)}</td>
                      <td className="num">{fmtInt(m.rejectedFromZoneByZone[z.code] ?? 0)}</td>
                      <td className="num">{fmtPct(m.excludedRateByZone[z.code])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Unique EPCs</dt>
              <dd>{fmtInt(m.uniqueEpcCount)}</dd>
              <dt>Uncertain (needs review) rate</dt>
              <dd>{fmtPct(m.uncertainRate)}</dd>
              <dt>Classification coverage</dt>
              <dd>{fmtPct(m.classificationCoverage)}</dd>
              <dt>Multi-zone overlap rate</dt>
              <dd>{fmtPct(m.multiZoneOverlapRate)}</dd>
              <dt>EPCs missing useful evidence</dt>
              <dd>
                {fmtPct(m.missingUsefulEvidenceRate)}{" "}
                <span className="small muted">(no RSSI, timing or read counts)</span>
              </dd>
              <dt>Confidence types</dt>
              <dd>
                {Object.entries(m.confidenceTypeCounts)
                  .map(([k, v]) => `${humanize(k)}: ${fmtInt(v)}`)
                  .join(" · ")}
              </dd>
            </dl>
            <h3 style={{ marginTop: 16 }}>Classification reasons</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th className="num">EPCs</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(m.reasonCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <tr key={k}>
                        <td>{humanize(k)}</td>
                        <td className="num">{fmtInt(v)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {can(ctx.role, "results:download") && (
              <p>
                <a className="btn btn-sm" href={`/api/v1/jobs/${job.id}/outputs/processing_summary`}>
                  Download processing_summary.csv
                </a>
              </p>
            )}
          </Card>

          <Card title="Accuracy against labeled ground truth">
            {!canCal ? (
              <p>
                Genuine-item recall and cross-zone false acceptance rate: <NeedsGroundTruth />
              </p>
            ) : evaluations.length === 0 ? (
              <>
                <p>
                  Genuine-item recall: <NeedsGroundTruth />
                </p>
                <p>
                  Cross-zone false acceptance rate: <NeedsGroundTruth />
                </p>
                <EvaluateForm
                  jobId={job.id}
                  datasets={datasets
                    .filter((d) => d.storeId === job.storeId)
                    .map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
                />
              </>
            ) : (
              <div className="stack">
                <EvaluateForm
                  jobId={job.id}
                  datasets={datasets
                    .filter((d) => d.storeId === job.storeId)
                    .map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
                />
                {evaluations.map((ev) => {
                  const r = ev.metrics as unknown as EvalReport;
                  return (
                    <div key={ev.id} className="card stack">
                      <div className="row">
                        <h3 style={{ margin: 0 }}>{ev.dataset.name}</h3>
                        <span className="small muted">
                          {fmtDate(ev.createdAt)} · {fmtInt(r.labeledCount)} labeled EPCs (
                          {fmtInt(r.labeledNotObservedCount)} not observed in the scans)
                        </span>
                        {ev.inSample && <Badge value="IN-SAMPLE — NOT A HOLDOUT ESTIMATE" tone="warn" />}
                      </div>
                      {r.labeledCount < 200 && (
                        <Alert tone="warn">Small label set: treat these figures as indicative only.</Alert>
                      )}
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Zone</th>
                              <th className="num">Ground-truth EPCs</th>
                              <th className="num">Recall (cleaned)</th>
                              <th className="num">Recall (raw)</th>
                              <th className="num">Precision</th>
                              <th className="num">False acceptance (cleaned)</th>
                              <th className="num">False acceptance (raw)</th>
                              <th className="num">In review</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(r.perZone).map(([z, e]) => (
                              <tr key={z}>
                                <td className="mono">{z}</td>
                                <td className="num">{fmtInt(e.groundTruthCount)}</td>
                                <td className="num">{fmtPct(e.recall)}</td>
                                <td className="num">{fmtPct(e.rawRecall)}</td>
                                <td className="num">{fmtPct(e.precision)}</td>
                                <td className="num">{fmtPct(e.falseAcceptanceRate)}</td>
                                <td className="num">{fmtPct(e.rawFalseAcceptanceRate)}</td>
                                <td className="num">{fmtInt(e.reviewCount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <h3>Confusion matrix (rows: actual zone)</h3>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Actual \ Outcome</th>
                              {r.confusion.predicted.map((p) => (
                                <th key={p} className="num">
                                  {humanize(p)}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {r.confusion.actual.map((a, i) => (
                              <tr key={a}>
                                <td className="mono">{a}</td>
                                {r.confusion.counts[i].map((c, j) => (
                                  <td key={j} className="num">
                                    {fmtInt(c)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="small muted">
              Definitions: recall = labeled EPCs truly in a zone that were accepted into it ÷ all labeled EPCs
              truly in that zone. False acceptance = labeled EPCs accepted into a zone whose true zone differs
              ÷ labeled EPCs accepted into that zone. The 95% recall target is a validation objective; it is
              not claimed until a representative labeled evaluation shows it.
            </p>
          </Card>
        </>
      )}
      {canCal && (
        <Card title="Calibration and ground-truth datasets">
          <div className="stack">
            <DatasetUpload
              stores={stores.map((s) => ({ id: s.id, name: s.name }))}
              jobs={allJobs.items.map((j) => ({
                id: j.id,
                storeId: j.storeId,
                label: `${j.id.slice(0, 8)} · ${fmtDate(j.completedAt)}`,
              }))}
              canWrite={can(ctx.role, "calibration:write")}
            />
            <DatasetList datasets={datasets.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))} />
          </div>
        </Card>
      )}
      <p className="small">
        <Link href="/settings">Processing profiles</Link>
      </p>
    </div>
  );
}
