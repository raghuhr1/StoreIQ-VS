export function JobPicker({
  jobs,
  selectedId,
  action,
}: {
  jobs: { id: string; label: string }[];
  selectedId?: string;
  action: string;
}) {
  return (
    <form method="get" action={action} className="row" style={{ alignItems: "flex-end" }}>
      <div className="field" style={{ minWidth: 360 }}>
        <label htmlFor="jobId">Processing job</label>
        <select id="jobId" name="jobId" defaultValue={selectedId}>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn">Show</button>
    </form>
  );
}
