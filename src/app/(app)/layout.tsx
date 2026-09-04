import Link from "next/link";

import { logoutAction } from "@/app/login/actions";
import { requireUser } from "@/lib/auth/rbac";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "ผู้ดูแลระบบส่วนกลาง",
  FACILITY_ADMIN: "ผู้ดูแลสถานบริการ",
  USER: "ผู้ใช้งาน",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const isSuper = user.role === "SUPER_ADMIN";

  const nav = [
    { href: "/dashboard", label: "แดชบอร์ด" },
    { href: "/reports/drug-usage", label: "รายงานปริมาณการจ่ายยา" },
    { href: "/sync", label: "สถานะการซิงก์" },
    ...(isSuper
      ? [
          { href: "/admin/facilities", label: "จัดการสถานบริการ" },
          { href: "/admin/agents", label: "จัดการ Agent" },
          { href: "/admin/users", label: "จัดการผู้ใช้" },
          { href: "/admin/monitoring", label: "การเฝ้าระวังระบบ" },
          { href: "/admin/audit", label: "บันทึกการใช้งาน" },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white">
            ยา
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">ศูนย์ข้อมูลการใช้ยา</p>
            <p className="truncate text-xs text-muted">อำเภอสันกำแพง</p>
          </div>
        </div>

        <nav className="px-3 pb-4 lg:pb-0" aria-label="เมนูหลัก">
          <ul className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-canvas hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto hidden border-t border-line px-5 py-4 lg:block">
          <p className="truncate text-sm font-medium text-ink">{user.fullName}</p>
          <p className="truncate text-xs text-muted">{ROLE_LABELS[user.role] ?? user.role}</p>
          <form action={logoutAction} className="mt-3">
            <button
              type="submit"
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              ออกจากระบบ
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0">
        <div className="flex items-center justify-end gap-4 border-b border-line bg-surface px-5 py-3 lg:hidden">
          <span className="text-xs text-muted">{user.fullName}</span>
          <form action={logoutAction}>
            <button type="submit" className="text-xs font-medium text-brand-700">
              ออกจากระบบ
            </button>
          </form>
        </div>
        <main className="mx-auto w-full max-w-7xl px-5 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
