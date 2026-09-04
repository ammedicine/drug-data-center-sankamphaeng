import { DataTable } from "@/components/ui/data-table";
import { Card, PageHeader, formatDateTime } from "@/components/ui/primitives";
import { requireSuperAdmin } from "@/lib/auth/rbac";
import { listAuditLogs } from "@/lib/services/facilities";

export const metadata = { title: "บันทึกการใช้งาน" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requireSuperAdmin();
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
                  <span className="text-sm text-ink">{row.actorLabel ?? "-"}</span>
                  <span className="block text-xs text-muted">{row.actorType}</span>
                </>
              ),
            },
            { key: "action", header: "การกระทำ", render: (row) => <code className="text-xs">{row.action}</code> },
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
