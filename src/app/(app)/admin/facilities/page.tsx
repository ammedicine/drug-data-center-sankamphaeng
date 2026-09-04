import { CellMeta, DataTable } from "@/components/ui/data-table";
import { Card, PageHeader, StatusBadge, relativeTime } from "@/components/ui/primitives";
import { canManageSystem, requireAllFacilityViewer } from "@/lib/auth/rbac";
import { listFacilities } from "@/lib/services/facilities";

import { CollapsibleForm, FacilityForm, FacilityToggleForm } from "../forms";

export const metadata = { title: "จัดการสถานบริการ" };
export const dynamic = "force-dynamic";

export default async function FacilitiesPage() {
  const user = await requireAllFacilityViewer();
  const canManage = canManageSystem(user);
  const rows = await listFacilities(null);

  return (
    <>
      <PageHeader
        title="จัดการสถานบริการ"
        subtitle="รพ.สต. ที่อยู่ในระบบ พร้อมสถานะ Agent และการซิงก์ข้อมูล"
      />

      {canManage ? (
        <div className="mb-5">
          <CollapsibleForm label="เพิ่มสถานบริการ">
            <Card className="mt-3">
              <div className="p-5">
                <FacilityForm />
              </div>
            </Card>
          </CollapsibleForm>
        </div>
      ) : null}

      <Card title={`สถานบริการทั้งหมด (${rows.length})`}>
        <DataTable
          rowKey={(row) => row.id}
          rows={rows}
          emptyTitle="ยังไม่มีสถานบริการ"
          emptyDescription="เริ่มต้นด้วยการเพิ่ม รพ.สต. แห่งแรกเข้าสู่ระบบ"
          columns={[
            {
              key: "facility",
              header: "สถานบริการ",
              render: (row) => (
                <>
                  <span className="font-medium text-ink">{row.name}</span>
                  <CellMeta>
                    {row.code} · pcucode {row.jhcisPcucode}
                  </CellMeta>
                </>
              ),
            },
            {
              key: "area",
              header: "พื้นที่",
              render: (row) => (
                <span className="text-xs text-muted">
                  {[row.subdistrict, row.district, row.province].filter(Boolean).join(" / ") || "-"}
                </span>
              ),
            },
            {
              key: "agents",
              header: "Agent",
              align: "right",
              render: (row) => row.agentCount,
            },
            {
              key: "users",
              header: "ผู้ใช้",
              align: "right",
              render: (row) => row.activeUsers,
            },
            {
              key: "heartbeat",
              header: "Heartbeat ล่าสุด",
              render: (row) => (
                <span className="text-xs text-muted">{relativeTime(row.lastHeartbeatAt)}</span>
              ),
            },
            {
              key: "sync",
              header: "ซิงก์ล่าสุด",
              render: (row) => (
                <span className="text-xs text-muted">{relativeTime(row.lastSuccessfulSyncAt)}</span>
              ),
            },
            {
              key: "status",
              header: "สถานะ",
              render: (row) => <StatusBadge status={row.isActive ? "ACTIVE" : "INACTIVE"} />,
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (row) =>
                canManage ? (
                  <FacilityToggleForm facilityId={row.id} isActive={row.isActive} />
                ) : null,
            },
          ]}
        />
      </Card>
    </>
  );
}
