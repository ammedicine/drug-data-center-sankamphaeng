import { CellMeta, DataTable } from "@/components/ui/data-table";
import { Card, PageHeader, formatDateTime } from "@/components/ui/primitives";
import { requireAllFacilityViewer } from "@/lib/auth/rbac";
import { listAuditLogs } from "@/lib/services/facilities";

export const metadata = { title: "บันทึกการใช้งาน" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requireAllFacilityViewer();
  const rows = await listAuditLogs(null, 200);

  return (
    <>
      <PageHeader
        title="บันทึกการใช้งาน (Audit Log)"
        subtitle="เหตุการณ์สำคัญ 200 รายการล่าสุด: การเข้าสู่ระบบ การจัดการสถานบริการ/Agent/ผู้ใช้ และการซิงก์ข้อมูล"
      />

      <Card>
        <DataTable
          rowKey={(row) => String(row.id)}
          rows={rows}
          emptyTitle="ยังไม่มีบันทึก"
          columns={[
            {
              key: "time",
              header: "เวลา",
              render: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>,
            },
            {
              key: "actor",
              header: "ผู้กระทำ",
              render: (row) => (
                <>
                  <span className="text-[13.5px] text-ink">{row.actorLabel ?? "-"}</span>
                  <CellMeta>{row.actorType}</CellMeta>
                </>
              ),
            },
            {
              key: "action",
              header: "การกระทำ",
              render: (row) => (
                <code className="rounded bg-raised px-1.5 py-0.5 text-xs text-ink-soft">
                  {row.action}
                </code>
              ),
            },
            {
              key: "resource",
              header: "ทรัพยากร",
              render: (row) => (
                <span className="text-xs text-muted">
                  {row.resource}
                  {row.resourceId ? ` · ${row.resourceId}` : ""}
                </span>
              ),
            },
            {
              key: "facility",
              header: "สถานบริการ",
              render: (row) => <span className="text-xs text-muted">{row.facilityName ?? "-"}</span>,
            },
            { key: "ip", header: "IP", render: (row) => <span className="text-xs text-muted">{row.ip ?? "-"}</span> },
          ]}
        />
      </Card>
    </>
  );
}
