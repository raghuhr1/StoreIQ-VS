"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export interface NavItem {
  href: string;
  label: string;
}

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={path === i.href || path.startsWith(i.href + "/") ? "page" : undefined}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function TenantSwitcher({
  current,
  memberships,
}: {
  current: string;
  memberships: { tenantId: string; tenantName: string }[];
}) {
  const router = useRouter();
  if (memberships.length < 2) return null;
  return (
    <div className="field">
      <label htmlFor="tenant-switch" className="small">
        Organization
      </label>
      <select
        id="tenant-switch"
        value={current}
        onChange={async (e) => {
          await api("/api/v1/auth/switch-tenant", { method: "POST", json: { tenantId: e.target.value } });
          router.push("/dashboard");
          router.refresh();
        }}
      >
        {memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantId}>
            {m.tenantName}
          </option>
        ))}
      </select>
    </div>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        await api("/api/v1/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
