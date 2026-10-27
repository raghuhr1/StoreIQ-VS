import Link from "next/link";
import { notFound } from "next/navigation";
import { AddZoneForm, RelationshipForm, ZoneRow } from "@/components/store-admin";
import { Card, PageHeader } from "@/components/ui";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { AppError } from "@/server/errors";
import { getStore } from "@/server/services/stores";

export const metadata = { title: "Store · Simple Virtual Shield" };

export default async function StorePage({ params }: { params: Promise<{ storeId: string }> }) {
  const ctx = await pageAuth();
  const { storeId } = await params;
  let store;
  try {
    store = await getStore(ctx, storeId);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const canEdit = can(ctx.role, "store:write");
  const zname = (id: string) => store.zones.find((z) => z.id === id)?.name ?? id;
  return (
    <div className="stack">
      <PageHeader
        title={store.name}
        description={
          <>
            Code <span className="mono">{store.code}</span> · {store.timeZone} (timestamps without an offset
            are read in this zone)
          </>
        }
        actions={
          <Link className="btn" href={`/anchors?storeId=${store.id}`}>
            Anchor tags
          </Link>
        }
      />
      <Card title="Zones">
        <p className="small muted">
          Aliases are matched (case- and punctuation-insensitive) against zone values in combined scan files.
          Zone codes are fixed once created because exports and calibration refer to them.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Aliases</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {store.zones.map((z) => (
                <ZoneRow key={z.id} storeId={store.id} zone={z} canEdit={canEdit} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {canEdit && (
        <Card title="Add a zone">
          <AddZoneForm storeId={store.id} />
        </Card>
      )}
      <Card title="Zone relationships (optional)">
        <p className="small muted">
          EPCs seen in two zones marked “physically separated” are always sent to review instead of being
          resolved as cross-reads.
        </p>
        {store.relationships.length > 0 && (
          <ul>
            {store.relationships.map((r) => (
              <li key={r.id}>
                {zname(r.fromZoneId)} — {r.relation.replace(/_/g, " ").toLowerCase()} — {zname(r.toZoneId)}
              </li>
            ))}
          </ul>
        )}
        {canEdit && store.zones.length > 1 && <RelationshipForm storeId={store.id} zones={store.zones} />}
      </Card>
    </div>
  );
}
