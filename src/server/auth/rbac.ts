import type { Role } from "@/generated/prisma/enums";

export const PERMISSIONS = {
  "dashboard:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "store:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "store:write": ["ADMIN", "MANAGER"],
  "upload:write": ["ADMIN", "MANAGER", "OPERATOR"],
  "mapping:write": ["ADMIN", "MANAGER", "OPERATOR"],
  "job:create": ["ADMIN", "MANAGER", "OPERATOR"],
  "job:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "results:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "results:download": ["ADMIN", "MANAGER", "OPERATOR"],
  "anchor:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "anchor:write": ["ADMIN", "MANAGER"],
  "profile:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
  "profile:write": ["ADMIN"],
  "calibration:read": ["ADMIN", "MANAGER"],
  "calibration:write": ["ADMIN", "MANAGER"],
  "users:manage": ["ADMIN"],
  "audit:read": ["ADMIN"],
  "settings:read": ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "Full access including users, processing profiles and audit logs",
  MANAGER: "Store configuration, anchors, calibration, processing and downloads",
  OPERATOR: "Upload scans, run processing, review and download results",
  VIEWER: "Read-only access to dashboards and results",
};
