import { DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  formatNumber,
  relativeTime,
} from "@/components/ui/primitives";
import { SyncHistoryCard } from "@/components/ui/sync-history";
import { canTriggerSync, isSuperAdmin, requireUser, resolveFacilityScope } from "@/lib/auth/rbac";

import { SyncNowForm, VerifyDataForm } from "../admin/forms";
import {
  getFleetSummary,
  listAgents,
  listRunningBatches,
  listSyncBatches,
} from "@/lib/services/monitoring";

export const metadata = { title: "สถานะการซิงก์" };
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const user = await requireUser();
  const scope = resolveFacilityScope(user);
  const canSeeTechnical = user.role !== "USER";

  const [agentRows, batches, fleet, running] = await Promise.all([
    listAgents(scope.facilityIds),
    listSyncBatches(scope.facilityIds, 50),
    getFleetSummary(scope.facilityIds),
    listRunningBatches(scope.facilityIds),
  ]);

  return (
    <>
      <PageHeader
        title="สถานะการซิงก์ข้อมูล"
        subtitle="ข้อมูลถูกดึงจาก JHCIS โดย Agent ที่ติดตั้งในเครือข่ายของสถานบริการ และส่งออกทาง HTTPS เท่านั้น"
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Agent ออนไลน์" value={`${fleet.online}/${fleet.agentsTotal}`} tone={fleet.offline ? "warn" : "ok"} />
        <StatCard label="ซิงก์ล่าสุด" value={relativeTime(fleet.lastSyncAt)} />
        <StatCard label="ซิงก์ล้มเหลว 24 ชม." value={fleet.failedBatches24h} tone={fleet.failedBatches24h ? "danger" : "default"} />
        <StatCard label="สถานบริการในสิทธิ์" value={isSuperAdmin(user) ? fleet.facilities : 1} />
      </div>

      {running.length ? (
        <Card
          className="mt-6"
          title="กำลังนำเข้าข้อมูล"
          description="ความคืบหน้าเทียบกับจำนวนรายการทั้งหมดที่ต้องนำเข้าในรอบนี้"
        >
          <div className="space-y-4 p-5">
            {running.map((batch) => (
              <div key={batch.batchRef}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {batch.facilityCode} · {batch.agentName}
                    <span className="ml-2 text-xs font-normal text-muted">{batch.batchRef}</span>
                  </span>
                  <span className="numeric text-xs text-muted">
                    {formatNumber(batch.recordsAccepted + batch.recordsRejected)} /{" "}
                    {formatNumber(batch.recordsRead)} รายการ (
                    {Math.round(batch.progress * 100)}%)
                  </span>
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-canvas"
                  role="progressbar"
                  aria-valuenow={Math.round(batch.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all"
                    style={{ width: `${Math.max(2, Math.round(batch.progress * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="my-6" title="Agent ของสถานบริการ">
        <DataTable
          rowKey={(row) => row.id}
          rows={agentRows}
          emptyTitle="ยังไม่มี Agent"
          emptyDescription="ติดต่อผู้ดูแลระบบส่วนกลางเพื่อสร้างและติดตั้ง Agent"
          columns={[
            {
              key: "agent",
              header: "Agent",
              render: (row) => (
                <>
                  <span className="font-medium text-ink">{row.name}</span>
                  <span className="block text-xs text-muted">{row.hostname ?? "-"}</span>
                </>
              ),
            },
            { key: "status", header: "สถานะ", render: (row) => <StatusBadge status={row.effectiveStatus} /> },
            {
              key: "heartbeat",
              header: "Heartbeat",
              render: (row) => <span className="text-xs text-muted">{relativeTime(row.lastHeartbeatAt)}</span>,
            },
            {
              key: "sync",
              header: "ซิงก์สำเร็จล่าสุด",
              render: (row) => <span className="text-xs text-muted">{formatDateTime(row.lastSuccessfulSyncAt)}</span>,
            },
            {
              key: "watermark",
              header: "ข้อมูลถึงวันที่",
              render: (row) => <span className="text-xs text-muted">{row.lastSyncedVisitDate ?? "-"}</span>,
            },
            ...(canTriggerSync(user)
              ? [
                  {
                    key: "actions",
                    header: "",
                    align: "right" as const,
                    render: (row: (typeof agentRows)[number]) =>
                      row.status !== "DISABLED" ? (
                        <div className="flex flex-col items-end gap-2">
                          <SyncNowForm agentId={row.id} />
                          <VerifyDataForm agentId={row.id} />
                        </div>
                      ) : null,
                  },
                ]
              : []),
            {
              key: "error",
              header: "ปัญหาล่าสุด",
              render: (row) =>
                row.lastError ? (
                  canSeeTechnical ? (
                    <span className="block max-w-[260px] truncate text-xs text-danger" title={row.lastError}>
                      {row.lastError}
                    </span>
                  ) : (
                    <span className="text-xs text-danger">พบปัญหา กรุณาแจ้งผู้ดูแลระบบ</span>
                  )
                ) : (
                  <span className="text-xs text-muted">-</span>
                ),
            },
          ]}
        />
      </Card>

      <SyncHistoryCard
        batches={batches}
        showFacility={isSuperAdmin(user)}
        showTechnicalError={canSeeTechnical}
        description="50 รอบล่าสุด"
      />
    </>
  );
}
