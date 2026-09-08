import { Activity, Building2, Server, TriangleAlert, WifiOff } from "lucide-react";
import { LiveStatusBadge } from "@/components/ui/live-refresh";
import { STALE_AFTER_SECONDS } from "@/lib/shared/agent-status";

import { CellMeta, DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  relativeTime,
} from "@/components/ui/primitives";
import { SyncHistoryCard } from "@/components/ui/sync-history";
import { requireAllFacilityViewer } from "@/lib/auth/rbac";
import {
  getFleetSummary,
  listAgents,
  listRunningBatches,
  listSyncBatches,
} from "@/lib/services/monitoring";
import { liveSignature } from "@/lib/shared/live-signature";

export const metadata = { title: "การเฝ้าระวังระบบ" };
export const dynamic = "force-dynamic";

export default async function MonitoringPage() {
  await requireAllFacilityViewer();

  const [fleet, agentRows, failed, recent, running] = await Promise.all([
    getFleetSummary(null),
    listAgents(null),
    listSyncBatches(null, 25, true),
    listSyncBatches(null, 25, false),
    // Not rendered here, but the poll reports it, and a signature that omits
    // it would differ from the poll's on every load while a sync is running -
    // a page rebuild with nothing behind it.
    listRunningBatches(null),
  ]);

  const stale = agentRows.filter((a) => a.effectiveStatus === "OFFLINE" || a.effectiveStatus === "ERROR");

  return (
    <>
      <PageHeader
        title="การเฝ้าระวังระบบ"
        subtitle={`Agent ถือว่าออฟไลน์เมื่อไม่มี heartbeat เกิน ${STALE_AFTER_SECONDS} วินาที`}
        actions={
          <LiveStatusBadge
            initialSignature={liveSignature({
              agents: agentRows.map((agent) => ({ ...agent, status: agent.effectiveStatus })),
              running,
            })}
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="สถานบริการ" value={fleet.facilities} icon={Building2} />
        <StatCard label="Agent ทั้งหมด" value={fleet.agentsTotal} icon={Server} />
        <StatCard label="ออนไลน์" value={fleet.online} tone="ok" icon={Activity} />
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

      <Card className="my-5" title="Agent ที่ต้องตรวจสอบ" description="ออฟไลน์หรือมีข้อผิดพลาด">
        <DataTable
          rowKey={(row) => row.id}
          rows={stale}
          emptyTitle="Agent ทุกตัวทำงานปกติ"
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
            { key: "status", header: "สถานะ", render: (row) => <StatusBadge status={row.effectiveStatus} /> },
            {
              key: "heartbeat",
              header: "Heartbeat ล่าสุด",
              render: (row) => (
                <span className="text-xs text-muted">
                  {formatDateTime(row.lastHeartbeatAt)} ({relativeTime(row.lastHeartbeatAt)})
                </span>
              ),
            },
            {
              key: "error",
              header: "ข้อผิดพลาด (technical)",
              render: (row) => (
                <span className="block max-w-[360px] truncate text-xs text-danger" title={row.lastError ?? ""}>
                  {row.lastError ?? "-"}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <div className="space-y-5">
        <SyncHistoryCard batches={failed} title="รอบที่ล้มเหลว" showTechnicalError />
        <SyncHistoryCard batches={recent} title="รอบล่าสุดทั้งหมด" showTechnicalError />
      </div>
    </>
  );
}
