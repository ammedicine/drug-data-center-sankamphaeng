import { DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  relativeTime,
} from "@/components/ui/primitives";
import { requireSuperAdmin } from "@/lib/auth/rbac";
import { listFacilityOptions } from "@/lib/services/facilities";
import { getFleetSummary, listAgents } from "@/lib/services/monitoring";

import {
  AgentForm,
  AgentRevokeForm,
  AgentTokenForm,
  CollapsibleForm,
  SyncNowForm,
} from "../forms";

export const metadata = { title: "จัดการ Agent" };
export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  await requireSuperAdmin();
  const [rows, facilities, fleet] = await Promise.all([
    listAgents(null),
    listFacilityOptions(null),
    getFleetSummary(null),
  ]);

  return (
    <>
      <PageHeader
        title="จัดการ Agent"
        subtitle="Agent คือโปรแกรมที่ติดตั้งในเครื่องที่เข้าถึง JHCISDB ของแต่ละ รพ.สต. และส่งข้อมูลออกทาง HTTPS เท่านั้น"
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Agent ทั้งหมด" value={fleet.agentsTotal} />
        <StatCard label="ออนไลน์" value={fleet.online} tone="ok" />
        <StatCard label="ออฟไลน์" value={fleet.offline} tone={fleet.offline ? "warn" : "default"} />
        <StatCard
          label="ซิงก์ล้มเหลว 24 ชม."
          value={fleet.failedBatches24h}
          tone={fleet.failedBatches24h ? "danger" : "default"}
        />
      </div>

      <Card className="my-6" title="ลงทะเบียน Agent ใหม่">
        <div className="p-5">
          {facilities.length ? (
            <CollapsibleForm label="+ สร้าง Agent">
              <AgentForm facilities={facilities} />
            </CollapsibleForm>
          ) : (
            <p className="text-sm text-muted">กรุณาเพิ่มสถานบริการก่อนสร้าง Agent</p>
          )}
        </div>
      </Card>

      <Card title={`Agent ทั้งหมด (${rows.length})`}>
        <DataTable
          rowKey={(row) => row.id}
          rows={rows}
          emptyTitle="ยังไม่มี Agent"
          emptyDescription="สร้าง Agent แล้วนำ enrollment token ไปติดตั้งที่เครื่องของ รพ.สต."
          columns={[
            {
              key: "agent",
              header: "Agent",
              render: (row) => (
                <>
                  <span className="font-medium text-ink">{row.name}</span>
                  <span className="block text-xs text-muted">
                    {row.facilityCode} · {row.facilityName}
                  </span>
                </>
              ),
            },
            {
              key: "host",
              header: "เครื่อง / เวอร์ชัน",
              render: (row) => (
                <span className="text-xs text-muted">
                  {row.hostname ?? "-"}
                  <span className="block">
                    agent {row.version ?? "-"} · JHCIS {row.jhcisVersion ?? "-"}
                  </span>
                </span>
              ),
            },
            {
              key: "status",
              header: "สถานะ",
              render: (row) => <StatusBadge status={row.effectiveStatus} />,
            },
            {
              key: "heartbeat",
              header: "Heartbeat",
              render: (row) => (
                <span className="text-xs text-muted">{relativeTime(row.lastHeartbeatAt)}</span>
              ),
            },
            {
              key: "sync",
              header: "ซิงก์สำเร็จล่าสุด",
              render: (row) => (
                <span className="text-xs text-muted">
                  {formatDateTime(row.lastSuccessfulSyncAt)}
                  <span className="block">
                    สำเร็จ {row.syncCount} · ล้มเหลว {row.failedCount}
                  </span>
                </span>
              ),
            },
            {
              key: "error",
              header: "ข้อผิดพลาดล่าสุด",
              render: (row) =>
                row.lastError ? (
                  <span className="block max-w-[240px] truncate text-xs text-danger" title={row.lastError}>
                    {row.lastError}
                  </span>
                ) : (
                  <span className="text-xs text-muted">-</span>
                ),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (row) => (
                <div className="flex flex-col items-end gap-2">
                  {row.status !== "DISABLED" ? <SyncNowForm agentId={row.id} /> : null}
                  <AgentTokenForm agentId={row.id} />
                  {row.status !== "DISABLED" ? <AgentRevokeForm agentId={row.id} /> : null}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
