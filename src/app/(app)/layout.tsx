import Link from "next/link";

import { logoutAction } from "@/app/login/actions";
import { requireUser } from "@/lib/auth/rbac";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "ผู้ดูแลระบบส่วนกลาง",
  ADMIN: "แอดมิน (ดูทุกสถานบริการ)",
  FACILITY_ADMIN: "ผู้ดูแลสถานบริการ",
  USER: "ผู้ใช้งาน",
};

interface NavItem {
  href: string;
  label: string;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // ADMIN reads every facility but changes nothing, so it gets the same pages
  // with the action controls removed (each page enforces this server-side too).
  const seesAllFacilities = user.role === "SUPER_ADMIN" || user.role === "ADMIN";

  // Menu wording follows the vocabulary used in รพ.สต. / สสอ. systems rather
  // than developer terms, and is grouped so administration is clearly separate
  // from day-to-day reporting.
  const sections: Array<{ title: string; items: NavItem[] }> = [
    {
      title: "ข้อมูลและรายงาน",
      items: [
        { href: "/dashboard", label: "หน้าหลัก" },
        { href: "/reports/drug-usage", label: "รายงานการใช้ยา" },
        { href: "/sync", label: "สถานะการนำเข้าข้อมูล" },
      ],
    },
    ...(seesAllFacilities
      ? [
          {
            title: "การจัดการระบบ",
            items: [
              { href: "/admin/facilities", label: "ทะเบียนสถานบริการ" },
              { href: "/admin/agents", label: "โปรแกรมเชื่อมข้อมูล (Agent)" },
              { href: "/admin/users", label: "ผู้ใช้งานระบบ" },
              { href: "/admin/monitoring", label: "ติดตามสถานะระบบ" },
              { href: "/admin/audit", label: "ประวัติการใช้งานระบบ" },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="flex flex-col border-b border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white">
            ยา
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">ศูนย์ข้อมูลการใช้ยา</p>
            <p className="truncate text-xs text-muted">อำเภอสันกำแพง</p>
          </div>
        </div>

        <nav className="flex-1 px-3 pb-4 lg:pb-0" aria-label="เมนูหลัก">
          {sections.map((section) => (
            <div key={section.title} className="mb-4 lg:mb-5">
              <p className="mb-1 hidden px-3 text-[11px] font-semibold uppercase tracking-wide text-muted/80 lg:block">
                {section.title}
              </p>
              <ul className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
                {section.items.map((item) => (
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
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-line px-5 py-4 lg:block">
          <p className="truncate text-sm font-medium text-ink">{user.fullName}</p>
          <p className="truncate text-xs text-muted">{ROLE_LABELS[user.role] ?? user.role}</p>
          <form action={logoutAction} className="mt-3">
            <button type="submit" className="text-xs font-medium text-brand-700 hover:underline">
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
