import Link from "next/link";
import { JobPicker } from "@/components/job-picker";
import { ResultsExplorer } from "@/components/results-explorer";
import { Card, Empty, PageHeader } from "@/components/ui";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { pickCompletedJob } from "@/server/services/job-picker";

export const metadata = { title: "Cleaned Inventory · Simple Virtual Shield" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ jobId?: string }> }) {
  const ctx = await pageAuth();
  const { jobs, selected, zones } = await pickCompletedJob(ctx, (await searchParams).jobId);
  return (
    <div className="stack">
      <PageHeader
        title="Cleaned inventory"
        description="EPCs accepted into a zone. Items needing review are listed under Exceptions, not here."
      />
      {!selected ? (
        <Card>
          <Empty>
            No completed jobs yet. <Link href="/upload">Upload scans</Link> to produce cleaned inventory.
          </Empty>
        </Card>
      ) : (
        <>
          <JobPicker jobs={jobs} selectedId={selected.id} action="/inventory" />
          {can(ctx.role, "results:download") && (
            <div className="row">
              <a className="btn btn-sm" href={`/api/v1/jobs/${selected.id}/outputs/cleaned_sales_floor`}>
                Download cleaned_sales_floor.csv
              </a>
              <a className="btn btn-sm" href={`/api/v1/jobs/${selected.id}/outputs/cleaned_back_room.csv`}>
                Download cleaned_back_room.csv
              </a>
              <Link className="btn btn-sm" href={`/jobs/${selected.id}`}>
                All outputs
              </Link>
            </div>
          )}
          <Card>
            <ResultsExplorer
              key={selected.id}
              jobId={selected.id}
              zones={zones}
              tabs={["cleaned", "observed"]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
