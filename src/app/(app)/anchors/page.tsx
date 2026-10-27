import { AnchorForm, AnchorToggle } from "@/components/store-admin";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listAnchors } from "@/server/services/anchors";
import { listStores } from "@/server/services/stores";

export const metadata = { title: "Anchor Tags · Simple Virtual Shield" };

export default async function AnchorsPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const ctx = await pageAuth();
  const stores = await listStores(ctx);
  const sp = await searchParams;
  const store = stores.find((s) => s.id === sp.storeId) ?? stores[0];
  const anchors = store ? await listAnchors(ctx, store.id) : [];
  const canEdit = can(ctx.role, "anchor:write");
  return (
    <div className="stack">
      <PageHeader
        title="Anchor tags"
        description="Optional passive tags fixed in known zones. They are excluded from inventory and used as weighted evidence about the reader's RF environment."
      />
      <Card>
        <p className="small muted" style={{ marginTop: 0 }}>
          Anchors are optional; processing works without them. An anchor read can itself be missed or
          cross-read, so anchor evidence is down-weighted until store calibration validates it, and a missing
          anchor is never treated as proof of reader location.
        </p>
      </Card>
      {!store ? (
        <Card>
          <Empty>Create a store first.</Empty>
        </Card>
      ) : (
        <>
          <form method="get" className="row" style={{ alignItems: "flex-end" }}>
            <div className="field">
              <label htmlFor="storeId">Store</label>
              <select id="storeId" name="storeId" defaultValue={store.id}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn">Show</button>
          </form>
          {canEdit && (
            <Card title="Register an anchor">
              <AnchorForm storeId={store.id} zones={store.zones} />
            </Card>
          )}
          <Card title={`Anchors — ${store.name}`}>
            {anchors.length === 0 ? (
              <Empty>No anchors registered.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>EPC</th>
                      <th>Zone</th>
                      <th>Location</th>
                      <th>Status</th>
                      <th>Registered</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {anchors.map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.epc}</td>
                        <td>{a.zone.name}</td>
                        <td>{a.description ?? "—"}</td>
                        <td>
                          <Badge
                            value={a.active ? "ACTIVE" : "INACTIVE"}
                            tone={a.active ? "ok" : "neutral"}
                          />
                        </td>
                        <td className="small">{fmtDate(a.registeredAt)}</td>
                        <td>
                          {canEdit && <AnchorToggle storeId={store.id} anchorId={a.id} active={a.active} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
