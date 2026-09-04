import { DataTable } from "@/components/ui/data-table";
import { Card, PageHeader, StatusBadge, formatDateTime } from "@/components/ui/primitives";
import {
  canManageUsers,
  canViewAllFacilities,
  isSuperAdmin,
  requireUser,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import { listFacilityOptions, listUsers } from "@/lib/services/facilities";
import { ErrorState } from "@/components/ui/primitives";

import { CollapsibleForm, UserForm, UserToggleForm } from "../forms";

export const metadata = { title: "จัดการผู้ใช้" };
export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "ผู้ดูแลระบบส่วนกลาง",
  ADMIN: "แอดมิน (ดูทุกสถานบริการ)",
  FACILITY_ADMIN: "ผู้ดูแลสถานบริการ",
  USER: "ผู้ใช้งาน",
};

export default async function UsersPage() {
  const user = await requireUser();
  const canManage = canManageUsers(user);
  if (!canManage && !canViewAllFacilities(user)) {
    return (
      <>
        <PageHeader title="จัดการผู้ใช้" />
        <ErrorState title="ไม่มีสิทธิ์เข้าถึงหน้านี้" />
      </>
    );
  }

  const scope = resolveFacilityScope(user);
  const [rows, facilities] = await Promise.all([
    listUsers(scope.facilityIds),
    listFacilityOptions(scope.facilityIds),
  ]);
  // self-registered and never approved: these are the ones an admin must act on
  const pending = rows.filter((row) => !row.isActive && !row.approvedAt);

  return (
    <>
      <PageHeader
        title="จัดการผู้ใช้"
        subtitle={
          isSuperAdmin(user)
            ? "ผู้ใช้ทั้งหมดในระบบ"
            : "ผู้ใช้ภายในสถานบริการของคุณเท่านั้น"
        }
      />

      {canManage ? (
        <Card className="mb-6" title="เพิ่มผู้ใช้">
          <div className="p-5">
            <CollapsibleForm label="+ เพิ่มผู้ใช้">
              <UserForm facilities={facilities} allowSuperAdmin={isSuperAdmin(user)} />
            </CollapsibleForm>
          </div>
        </Card>
      ) : null}

      {pending.length ? (
        <Card
          className="mb-6"
          title={`รออนุมัติ (${pending.length})`}
          description="บัญชีที่สมัครเข้ามาเอง ยังเข้าใช้งานไม่ได้จนกว่าจะได้รับอนุมัติ"
        >
          <DataTable
            rowKey={(row) => row.id}
            rows={pending}
            emptyTitle="ไม่มีบัญชีรออนุมัติ"
            columns={[
              {
                key: "user",
                header: "ผู้สมัคร",
                render: (row) => (
                  <>
                    <span className="font-medium text-ink">{row.fullName}</span>
                    <span className="block text-xs text-muted">
                      {row.username ?? row.email} · {row.position ?? "-"}
                    </span>
                  </>
                ),
              },
              {
                key: "facility",
                header: "สถานบริการที่ขอเข้าถึง",
                render: (row) => (
                  <span className="text-xs text-muted">{row.facilityName ?? "-"}</span>
                ),
              },
              {
                key: "created",
                header: "สมัครเมื่อ",
                render: (row) => (
                  <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>
                ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (row) =>
                  canManage ? <UserToggleForm userId={row.id} isActive={false} pending /> : null,
              },
            ]}
          />
        </Card>
      ) : null}

      <Card title={`ผู้ใช้ทั้งหมด (${rows.length})`}>
        <DataTable
          rowKey={(row) => row.id}
          rows={rows}
          emptyTitle="ยังไม่มีผู้ใช้"
          columns={[
            {
              key: "user",
              header: "ผู้ใช้",
              render: (row) => (
                <>
                  <span className="font-medium text-ink">{row.fullName}</span>
                  <span className="block text-xs text-muted">
                    {row.username ? `${row.username} · ` : ""}
                    {row.position ?? row.email}
                  </span>
                </>
              ),
            },
            {
              key: "role",
              header: "บทบาท",
              render: (row) => <span className="text-xs">{ROLE_LABELS[row.role] ?? row.role}</span>,
            },
            {
              key: "facility",
              header: "สถานบริการ",
              render: (row) => (
                <span className="text-xs text-muted">{row.facilityName ?? "ทุกสถานบริการ"}</span>
              ),
            },
            {
              key: "login",
              header: "เข้าใช้ล่าสุด",
              render: (row) => (
                <span className="text-xs text-muted">{formatDateTime(row.lastLoginAt)}</span>
              ),
            },
            {
              key: "status",
              header: "สถานะ",
              render: (row) => (
                <StatusBadge
                  status={row.isActive ? "ACTIVE" : row.approvedAt ? "INACTIVE" : "PENDING"}
                />
              ),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (row) =>
                canManage ? (
                  <UserToggleForm
                    userId={row.id}
                    isActive={row.isActive}
                    pending={!row.isActive && !row.approvedAt}
                  />
                ) : null,
            },
          ]}
        />
      </Card>
    </>
  );
}
