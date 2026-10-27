import Link from "next/link";
import { LogoutButton, Nav, TenantSwitcher, type NavItem } from "@/components/nav";
import { pageAuth } from "@/server/auth/page";
import { can, type Permission } from "@/server/auth/rbac";

const NAV: (NavItem & { permission: Permission })[] = [
  { href: "/dashboard", label: "Dashboard", permission: "dashboard:read" },
  { href: "/upload", label: "Upload Scans", permission: "upload:write" },
  { href: "/jobs", label: "Processing Jobs", permission: "job:read" },
  { href: "/inventory", label: "Cleaned Inventory", permission: "results:read" },
  { href: "/exceptions", label: "Exceptions", permission: "results:read" },
  { href: "/reports", label: "Reports", permission: "results:read" },
  { href: "/stores", label: "Store Configuration", permission: "store:read" },
  { href: "/anchors", label: "Anchor Tags", permission: "anchor:read" },
  { href: "/users", label: "Users and Access", permission: "users:manage" },
  { href: "/audit", label: "Audit Logs", permission: "audit:read" },
  { href: "/settings", label: "Settings", permission: "settings:read" },
];

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await pageAuth();
  const items = NAV.filter((n) => can(ctx.role, n.permission)).map(({ href, label }) => ({ href, label }));
  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/dashboard" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="brand-mark" aria-hidden>
            SV
          </div>
          <div>
            <div className="brand-name">Simple Virtual Shield</div>
            <div className="brand-sub">StoreIQ</div>
          </div>
        </Link>
        <Nav items={items} />
        <div className="sidebar-foot">
          <TenantSwitcher current={ctx.tenantId} memberships={ctx.memberships} />
          <div>
            <div style={{ fontWeight: 600 }}>{ctx.name}</div>
            <div className="muted">
              {ctx.tenantName} · {ctx.role.toLowerCase()}
            </div>
          </div>
          <LogoutButton />
        </div>
      </aside>
      <main id="main" className="main">
        {children}
      </main>
    </div>
  );
}
