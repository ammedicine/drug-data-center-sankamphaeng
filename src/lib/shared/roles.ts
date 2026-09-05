/**
 * Thai names for the four roles.
 *
 * Client components read these too, so they live here rather than in an RBAC
 * module that pulls in the database. These are labels only - what a role may
 * actually do is decided in src/lib/auth/rbac.ts and nowhere else.
 */
export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "ผู้ดูแลระบบส่วนกลาง",
  ADMIN: "แอดมิน (ดูทุกสถานบริการ)",
  FACILITY_ADMIN: "ผู้ดูแลสถานบริการ",
  USER: "ผู้ใช้งาน",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
