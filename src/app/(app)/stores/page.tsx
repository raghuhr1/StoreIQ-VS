import Link from "next/link";
import { CreateStoreForm } from "@/components/store-admin";
import { Card, Empty, PageHeader } from "@/components/ui";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listStores } from "@/server/services/stores";

export const metadata = { title: "Store Configuration · Simple Virtual Shield" };

export default async function StoresPage() {
  const ctx = await pageAuth();
  const stores = await listStores(ctx);
  return (
    <div className="stack">
      <PageHeader
        title="Store configuration"
        description="Stores, zones, zone aliases used in scan exports, and zone relationships."
      />
      {can(ctx.role, "store:write") && (
        <Card title="Add a store">
          <CreateStoreForm />
        </Card>
      )}
      <Card title="Stores">
        {stores.length === 0 ? (
          <Empty>No stores yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Time zone</th>
                  <th>Zones</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/stores/${s.id}`}>{s.name}</Link>
                    </td>
                    <td className="mono">{s.code}</td>
                    <td>{s.timeZone}</td>
                    <td>
                      {s.zones
                        .filter((z) => z.active)
                        .map((z) => z.name)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
