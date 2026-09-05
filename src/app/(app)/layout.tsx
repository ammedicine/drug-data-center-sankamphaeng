import { logoutAction } from "@/app/login/actions";
import { ROLE_LABELS } from "@/lib/shared/roles";
import { AppNav, type NavSection } from "@/components/ui/app-nav";
import { requireUser } from "@/lib/auth/rbac";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // ADMIN reads every facility but changes nothing, so it gets the same pages
  // with the action controls removed (each page enforces this server-side too).
  const seesAllFacilities = user.role === "SUPER_ADMIN" || user.role === "ADMIN";

  // Menu wording follows the vocabulary used in รพ.สต. / สสอ. systems rather
  // than developer terms, and is grouped so administration is clearly separate
  // from day-to-day reporting.
  const sections: NavSection[] = [
    {
      title: "ข้อมูลและรายงาน",
      items: [
        { href: "/dashboard", label: "หน้าหลัก", icon: "dashboard" },
        { href: "/reports/drug-usage", label: "รายงานการใช้ยา", icon: "report" },
        { href: "/sync", label: "สถานะการนำเข้าข้อมูล", icon: "sync" },
      ],
    },
    ...(seesAllFacilities
      ? [
          {
            title: "การจัดการระบบ",
            items: [
              { href: "/admin/facilities", label: "ทะเบียนสถานบริการ", icon: "facility" as const },
              { href: "/admin/agents", label: "โปรแกรมเชื่อมข้อมูล (Agent)", icon: "agent" as const },
              { href: "/admin/users", label: "ผู้ใช้งานระบบ", icon: "users" as const },
              { href: "/admin/monitoring", label: "ติดตามสถานะระบบ", icon: "monitoring" as const },
              { href: "/admin/audit", label: "ประวัติการใช้งานระบบ", icon: "audit" as const },
            ],
          },
        ]
      : []),
  ];

  return (
    <div data-app-shell className="flex min-h-screen flex-col lg:flex-row">
      <AppNav
        sections={sections}
        fullName={user.fullName}
        roleLabel={ROLE_LABELS[user.role] ?? user.role}
        logout={logoutAction}
      />

      <div className="min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
