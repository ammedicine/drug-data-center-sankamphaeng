import { Server, TriangleAlert, Wifi, WifiOff } from "lucide-react";

import { CellMeta, DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  relativeTime,
} from "@/components/ui/primitives";
import { canManageSystem, requireAllFacilityViewer } from "@/lib/auth/rbac";
import { listFacilityOptions } from "@/lib/services/facilities";
import { getFleetSummary, listAgents } from "@/lib/services/monitoring";

import {
  AgentForm,
  AgentDeleteForm,
  AgentRevokeForm,
  AgentTokenForm,
  CollapsibleForm,
  SyncNowForm,
} from "../forms";

export const metadata = { title: "จัดการ Agent" };
export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const user = await requireAllFacilityViewer();
  const canManage = canManageSystem(user);
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Agent ทั้งหมด" value={fleet.agentsTotal} icon={Server} />
        <StatCard label="ออนไลน์" value={fleet.online} tone="ok" icon={Wifi} />
        <StatCard
          label="ออฟไลน์"
          value={fleet.offline}
          tone={fleet.offline ? "warn" : "default"}
          icon={WifiOff}
        />
        <StatCard
          label="ซิงก์ล้มเหลว 24 ชม."
          value={fleet.failedBatches24h}
          tone={fleet.failedBatches24h ? "danger" : "default"}
          icon={TriangleAlert}
        />
      </div>

      {canManage ? (
        <div className="my-5">
          {facilities.length ? (
            <CollapsibleForm label="ลงทะเบียน Agent ใหม่">
              <Card className="mt-3">
                <div className="p-5">
                  <AgentForm facilities={facilities} />
                </div>
              </Card>
            </CollapsibleForm>
          ) : (
            <p className="text-[13px] text-muted">กรุณาเพิ่มสถานบริการก่อนสร้าง Agent</p>
          )}
        </div>
      ) : (
        <div className="my-5" />
      )}

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
                  <CellMeta>
                    {row.facilityCode} · {row.facilityName}
                  </CellMeta>
                </>
              ),
            },
            {
              key: "host",
              header: "เครื่อง / เวอร์ชัน",
              render: (row) => (
                <span className="text-[13px] text-muted">
                  {row.hostname ?? "-"}
                  <span className="mt-0.5 block text-xs">
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
                <span className="text-[13px] text-muted">
                  {formatDateTime(row.lastSuccessfulSyncAt)}
                  <span className="mt-0.5 block text-xs">
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
              render: (row) =>
                canManage ? (
                  <div className="flex flex-col items-end gap-2">
                    {row.status !== "DISABLED" ? <SyncNowForm agentId={row.id} /> : null}
                    <AgentTokenForm agentId={row.id} />
                    {row.status !== "DISABLED" ? <AgentRevokeForm agentId={row.id} /> : null}
                    <AgentDeleteForm agentId={row.id} agentName={row.name} />
                  </div>
                ) : null,
            },
          ]}
        />
      </Card>
    </>
  );
}
