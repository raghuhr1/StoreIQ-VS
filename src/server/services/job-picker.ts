import type { AuthContext } from "../auth/context";
import { listJobs } from "./jobs";
import { listStores } from "./stores";

/** Completed jobs to choose from, defaulting to the most recent one. */
export async function pickCompletedJob(ctx: AuthContext, jobId?: string) {
  const [jobs, stores] = await Promise.all([
    listJobs(ctx, { status: "COMPLETED", limit: 100, offset: 0 }),
    listStores(ctx),
  ]);
  const selected = jobs.items.find((j) => j.id === jobId) ?? jobs.items[0] ?? null;
  const store = selected ? stores.find((s) => s.id === selected.storeId) : null;
  return {
    jobs: jobs.items.map((j) => ({
      id: j.id,
      label: `${j.store.name} · ${j.completedAt?.toISOString().slice(0, 16).replace("T", " ")} UTC · ${j.id.slice(0, 8)}`,
    })),
    selected,
    zones: store?.zones.map((z) => ({ id: z.id, code: z.code, name: z.name })) ?? [],
  };
}
