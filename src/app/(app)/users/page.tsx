import { AddMemberForm, MemberActions } from "@/components/admin-forms";
import { Badge, Card, Forbidden, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { pageAuth } from "@/server/auth/page";
import { can, ROLE_DESCRIPTIONS } from "@/server/auth/rbac";
import { listMembers } from "@/server/services/users";

export const metadata = { title: "Users and Access · Simple Virtual Shield" };

export default async function UsersPage() {
  const ctx = await pageAuth();
  if (!can(ctx.role, "users:manage")) return <Forbidden />;
  const members = await listMembers(ctx);
  return (
    <div className="stack">
      <PageHeader title="Users and access" description={`Members of ${ctx.tenantName}.`} />
      <Card title="Add a user">
        <AddMemberForm />
      </Card>
      <Card title="Members">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th>Role and actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId}>
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>
                    {m.disabledAt ? (
                      <Badge value="DISABLED" tone="bad" />
                    ) : m.mustChangePassword ? (
                      <Badge value="PASSWORD PENDING" tone="warn" />
                    ) : (
                      <Badge value="ACTIVE" tone="ok" />
                    )}
                  </td>
                  <td className="small">{fmtDate(m.lastLoginAt)}</td>
                  <td>
                    <MemberActions
                      userId={m.id}
                      role={m.role}
                      disabled={!!m.disabledAt}
                      self={m.id === ctx.userId}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Roles">
        <dl className="kv">
          {Object.entries(ROLE_DESCRIPTIONS).map(([r, d]) => [
            <dt key={r}>{r.toLowerCase()}</dt>,
            <dd key={`${r}-d`}>{d}</dd>,
          ])}
        </dl>
      </Card>
    </div>
  );
}
