import { Forbidden, PageHeader } from "@/components/ui";
import { UploadWizard } from "@/components/upload-wizard";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listProfiles } from "@/server/services/profiles";
import { listStores } from "@/server/services/stores";

export const metadata = { title: "Upload Scans · Simple Virtual Shield" };

export default async function UploadPage() {
  const ctx = await pageAuth();
  if (!can(ctx.role, "upload:write")) return <Forbidden />;
  const [stores, profiles] = await Promise.all([listStores(ctx), listProfiles(ctx)]);
  return (
    <div className="stack">
      <PageHeader
        title="Upload scans"
        description="No change to the handheld workflow: scan and export as usual, then upload the exported files here."
      />
      <UploadWizard
        stores={stores.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          zones: s.zones.filter((z) => z.active).map((z) => ({ id: z.id, code: z.code, name: z.name })),
        }))}
        profiles={profiles.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          isDefault: p.isDefault,
        }))}
        canSaveMapping={can(ctx.role, "mapping:write")}
      />
    </div>
  );
}
