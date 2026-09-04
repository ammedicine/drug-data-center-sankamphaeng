import { DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  relativeTime,
} from "@/components/ui/primitives";
import { SyncHistoryCard } from "@/components/ui/sync-history";
import { requireSuperAdmin } from "@/lib/auth/rbac";
import {
  HEARTBEAT_TIMEOUT_MINUTES,
  getFleetSummary,
  listAgents,
  listSyncBatches,
} from "@/lib/services/monitoring";

export const metadata = { title: "การเฝ้าระวังระบบ" };
export const dynamic = "force-dynamic";

export default async function MonitoringPage() {
  await requireSuperAdmin();

  const [fleet, agentRows, failed, recent] = await Promise.all([
    getFleetSummary(null),
    listAgents(null),
    listSyncBatches(null, 25, true),
    listSyncBatches(null, 25, false),
  ]);

  const stale = agentRows.filter((a) => a.effectiveStatus === "OFFLINE" || a.effectiveStatus === "ERROR");

  return (
    <>
      <PageHeader
        title="การเฝ้าระวังระบบ"
        subtitle={`Agent ถือว่าออฟไลน์เมื่อไม่มี heartbeat เกิน ${HEARTBEAT_TIMEOUT_MINUTES} นาที`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="สถานบริการ" value={fleet.facilities} />
        <StatCard label="Agent ทั้งหมด" value={fleet.agentsTotal} />
        <StatCard label="ออนไลน์" value={fleet.online} tone="ok" />
        <StatCard label="ออฟไลน์" value={fleet.offline} tone={fleet.offline ? "warn" : "default"} />
        <StatCard label="ซิงก์ล้มเหลว 24 ชม." value={fleet.failedBatches24h} tone={fleet.failedBatches24h ? "danger" : "default"} />
      </div>

      <Card className="my-6" title="Agent ที่ต้องตรวจสอบ" description="ออฟไลน์หรือมีข้อผิดพลาด">
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
                  <span className="block text-xs text-muted">
                    {row.facilityCode} · {row.facilityName}
                  </span>
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

      <div className="space-y-6">
        <SyncHistoryCard batches={failed} title="รอบที่ล้มเหลว" showTechnicalError />
        <SyncHistoryCard batches={recent} title="รอบล่าสุดทั้งหมด" showTechnicalError />
      </div>
    </>
  );
}
