import Link from "next/link";
import { JobPicker } from "@/components/job-picker";
import { ResultsExplorer } from "@/components/results-explorer";
import { Card, Empty, PageHeader } from "@/components/ui";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { pickCompletedJob } from "@/server/services/job-picker";

export const metadata = { title: "Exceptions · Simple Virtual Shield" };

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const ctx = await pageAuth();
  const { jobs, selected, zones } = await pickCompletedJob(ctx, (await searchParams).jobId);
  return (
    <div className="stack">
      <PageHeader
        title="Exceptions"
        description="EPCs that need review, and EPCs excluded from a zone as likely cross-reads. Exclusion from a zone never means the item is absent from the store."
      />
      {!selected ? (
        <Card>
          <Empty>No completed jobs yet.</Empty>
        </Card>
      ) : (
        <>
          <JobPicker jobs={jobs} selectedId={selected.id} action="/exceptions" />
          {can(ctx.role, "results:download") && (
            <div className="row">
              <a className="btn btn-sm" href={`/api/v1/jobs/${selected.id}/outputs/exceptions`}>
                Download exceptions.csv
              </a>
              <Link className="btn btn-sm" href={`/jobs/${selected.id}`}>
                Job details
              </Link>
            </div>
          )}
          <Card>
            <ResultsExplorer
              key={selected.id}
              jobId={selected.id}
              zones={zones}
              tabs={["exceptions", "errors"]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
