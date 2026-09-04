import { Card, ErrorState, PageHeader, StatCard } from "@/components/ui/primitives";
import {
  canApproveRegistration,
  canManageUsers,
  canViewAllFacilities,
  isSuperAdmin,
  requireUser,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import { listFacilityOptions, listUsers } from "@/lib/services/facilities";

import { UserManager, type ManagedUser } from "./user-manager";

export const metadata = { title: "ผู้ใช้งานระบบ" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const user = await requireUser();
  const canManage = canManageUsers(user);

  if (!canManage && !canViewAllFacilities(user)) {
    return (
      <>
        <PageHeader title="ผู้ใช้งานระบบ" />
        <ErrorState title="ไม่มีสิทธิ์เข้าถึงหน้านี้" />
      </>
    );
  }

  const scope = resolveFacilityScope(user);
  const [rows, facilities] = await Promise.all([
    listUsers(scope.facilityIds),
    listFacilityOptions(scope.facilityIds),
  ]);

  // Dates cross the server/client boundary as strings so the table can format
  // them without shipping Date objects through serialisation.
  const users: ManagedUser[] = rows.map((row) => ({
    id: row.id,
    username: row.username,
    position: row.position,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    facilityId: row.facilityId,
    facilityName: row.facilityName,
    isActive: row.isActive,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  }));

  const pending = users.filter((row) => !row.isActive && !row.approvedAt).length;
  const active = users.filter((row) => row.isActive).length;

  return (
    <>
      <PageHeader
        title="ผู้ใช้งานระบบ"
        subtitle={
          isSuperAdmin(user)
            ? "อนุมัติผู้สมัครใหม่ แก้ไขข้อมูล เปลี่ยนบทบาท ตั้งรหัสผ่านใหม่ และลบบัญชี"
            : "ผู้ใช้ภายในสถานบริการของคุณ (การอนุมัติผู้สมัครใหม่เป็นสิทธิ์ของผู้ดูแลระบบส่วนกลาง)"
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="ผู้ใช้ทั้งหมด" value={users.length} unit="บัญชี" />
        <StatCard label="ใช้งานอยู่" value={active} unit="บัญชี" tone="ok" />
        <StatCard
          label="รออนุมัติ"
          value={pending}
          unit="บัญชี"
          tone={pending ? "warn" : "default"}
          hint={pending ? "ผู้ดูแลระบบส่วนกลางเป็นผู้อนุมัติ" : undefined}
        />
      </div>

      {pending > 0 && !canApproveRegistration(user) ? (
        <Card className="mb-6">
          <p className="px-5 py-4 text-sm text-warn">
            มีผู้สมัคร {pending} รายรออนุมัติ — บัญชีที่สมัครเข้ามาเองต้องให้ผู้ดูแลระบบส่วนกลางตรวจสอบ
            รหัสสถานบริการก่อนเปิดใช้งาน
          </p>
        </Card>
      ) : null}

      <UserManager
        users={users}
        facilities={facilities}
        allowDistrictRoles={isSuperAdmin(user)}
        canManage={canManage}
        canApproveRegistration={canApproveRegistration(user)}
        currentUserId={user.userId}
      />
    </>
  );
}
