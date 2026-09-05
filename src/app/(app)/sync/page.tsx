import { CellMeta, DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatNumber,
  relativeTime,
} from "@/components/ui/primitives";
import { SyncHistoryCard } from "@/components/ui/sync-history";
import { ROLE_LABELS } from "@/lib/shared/roles";
import { lookupLatestAgentRelease } from "@/lib/services/agent-release";
import { Building2, Download, RefreshCcw, Server, TriangleAlert } from "lucide-react";
import {
  canManageFacility,
  canTriggerSync,
  isSuperAdmin,
  requireUser,
  resolveFacilityScope,
} from "@/lib/auth/rbac";

import { AgentTokenForm, SyncNowForm, VerifyDataForm } from "../admin/forms";
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

  // A USER sees the machines they enrolled and nothing else. SUPER_ADMIN sees
  // every facility, and a FACILITY_ADMIN sees its own สถานบริการ, because both
  // are responsible for more than their own desk.
  const ownAgentsOnly = user.role === "USER" ? user.userId : null;

  const [agentRows, batches, fleet, running, release] = await Promise.all([
    listAgents(scope.facilityIds, ownAgentsOnly),
    listSyncBatches(scope.facilityIds, 50),
    getFleetSummary(scope.facilityIds),
    listRunningBatches(scope.facilityIds),
    lookupLatestAgentRelease(),
  ]);

  // Downloading the installer is only half the job: the tray is useless until
  // it is enrolled, and until now the only page that issued a token was the
  // central admin area, which a รพ.สต. account cannot open. The permission to
  // enrol an agent for one's own facility already existed - it just had
  // nowhere to be used from.
  const enrollable = agentRows.filter((agent) => canManageFacility(user, agent.facilityId));

  return (
    <>
      <PageHeader
        title="สถานะการซิงก์ข้อมูล"
        subtitle="ข้อมูลถูกดึงจาก JHCIS โดย Agent ที่ติดตั้งในเครือข่ายของสถานบริการ และส่งออกทาง HTTPS เท่านั้น"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Agent ออนไลน์"
          value={`${fleet.online}/${fleet.agentsTotal}`}
          tone={fleet.offline ? "warn" : "ok"}
          icon={Server}
          accent
        />
        <StatCard label="ซิงก์ล่าสุด" value={relativeTime(fleet.lastSyncAt)} icon={RefreshCcw} />
        <StatCard
          label="ซิงก์ล้มเหลว 24 ชม."
          value={fleet.failedBatches24h}
          tone={fleet.failedBatches24h ? "danger" : "default"}
          icon={TriangleAlert}
        />
        <StatCard
          label="สถานบริการในสิทธิ์"
          value={isSuperAdmin(user) ? fleet.facilities : 1}
          icon={Building2}
        />
      </div>

      <Card
        className="mt-5"
        title="โปรแกรมเชื่อมข้อมูล JHCIS (Agent)"
        description="ติดตั้งบนเครื่องในเครือข่ายของสถานบริการที่มองเห็น JHCISDB"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 p-5">
          {release.status === "ok" ? (
            <>
              <div className="min-w-[240px]">
                <p className="text-[13.5px] text-ink">
                  เวอร์ชันล่าสุด{" "}
                  <span className="numeric font-semibold">{release.release.version}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {release.release.fileName} · {(release.release.sizeBytes / 1024 / 1024).toFixed(1)} MB
                  {release.release.publishedAt
                    ? ` · เผยแพร่ ${formatDateTime(release.release.publishedAt)}`
                    : ""}
                </p>
                <p className="mt-1.5 text-xs text-muted">
                  ติดตั้งทับเวอร์ชันเดิมได้ทันที ตัวติดตั้งจะปิดโปรแกรมที่ทำงานอยู่
                  และถอนเวอร์ชันเก่าออกให้เอง โดยไม่ลบข้อมูลที่ยังส่งไม่สำเร็จ
                </p>
              </div>
              <a
                href="/download/agent"
                className="inline-flex items-center gap-2 rounded-[6px] bg-brand px-3.5 py-2 text-[13.5px] font-medium text-white transition-colors duration-150 hover:bg-brand-hover"
              >
                <Download aria-hidden className="size-4" />
                ดาวน์โหลดตัวติดตั้ง
              </a>
            </>
          ) : (
            <p className="text-[13.5px] text-muted">
              {release.status === "not-configured"
                ? "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GITHUB_TOKEN จึงดึงไฟล์ติดตั้งมาแสดงไม่ได้"
                : release.status === "none-published"
                  ? "ยังไม่มีไฟล์ติดตั้งเผยแพร่ — ผู้ดูแลระบบต้องสร้าง release พร้อมไฟล์ SDCAgent-Setup-x.y.z.exe ก่อน"
                  : `ดึงข้อมูลไฟล์ติดตั้งไม่สำเร็จ: ${release.detail}`}
            </p>
          )}
        </div>
      </Card>

      <Card
        className="mt-5"
        title="เชื่อมต่อโปรแกรมกับระบบ"
        description="ทำครั้งเดียวตอนติดตั้งเสร็จ เพื่อผูกเครื่องนี้เข้ากับสถานบริการของคุณ"
      >
        <div className="space-y-4 p-5">
          <ol className="ml-4 list-decimal space-y-1.5 text-[13.5px] text-ink marker:text-muted">
            <li>ติดตั้งโปรแกรมบนเครื่องที่มองเห็น JHCISDB แล้วเปิดขึ้นมา</li>
            <li>ไปที่แท็บ &quot;ตั้งค่า&quot; กรอกที่อยู่ JHCISDB แล้วกดทดสอบการเชื่อมต่อ</li>
            <li>
              นำ <span className="font-medium">รหัสลงทะเบียน</span> ด้านล่างไปวางในช่อง
              &quot;ลงทะเบียนกับระบบศูนย์กลาง&quot; แล้วกดลงทะเบียน
            </li>
          </ol>

          {enrollable.length ? (
            <div className="space-y-3">
              {enrollable.map((agent) => (
                <div
                  key={agent.id}
                  className="rounded-[8px] border border-line bg-raised/40 p-4"
                >
                  <p className="text-[13.5px] font-medium text-ink">
                    {agent.name}
                    <span className="ml-2 text-xs font-normal text-muted">
                      {agent.facilityCode} · {agent.facilityName}
                    </span>
                  </p>
                  <p className="mt-0.5 mb-2.5 text-xs text-muted">
                    รหัสใช้ได้ครั้งเดียวและมีวันหมดอายุ · ออกรหัสใหม่ได้ทุกเมื่อ
                    รหัสเดิมจะใช้ไม่ได้ทันที
                  </p>
                  <AgentTokenForm agentId={agent.id} label="ขอรหัสลงทะเบียน" />
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[8px] bg-raised px-4 py-3 text-[13px] text-muted">
              {agentRows.length ? (
                <>
                  <p>
                    บัญชีของคุณเป็น <span className="font-medium">{ROLE_LABELS[user.role]}</span>{" "}
                    จึงขอรหัสลงทะเบียนเองไม่ได้
                  </p>
                  <p className="mt-1">
                    ขอได้ 2 ทาง: แจ้งผู้ดูแลระบบส่วนกลางให้ออกรหัสให้
                    หรือขอให้เปลี่ยนบัญชีของคุณเป็น{" "}
                    <span className="font-medium">ผู้ดูแลสถานบริการ</span>{" "}
                    แล้วจะขอรหัสของสถานบริการตัวเองได้เองทุกเมื่อ
                  </p>
                </>
              ) : (
                <p>สถานบริการของคุณยังไม่มี Agent ในระบบ กรุณาแจ้งผู้ดูแลระบบส่วนกลางให้สร้างให้ก่อน</p>
              )}
            </div>
          )}
        </div>
      </Card>

      {running.length ? (
        <Card
          className="mt-5"
          title="กำลังนำเข้าข้อมูล"
          description="ความคืบหน้าเทียบกับจำนวนรายการทั้งหมดที่ต้องนำเข้าในรอบนี้"
        >
          <div className="space-y-4 p-5">
            {running.map((batch) => (
              <div key={batch.batchRef}>
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-medium text-ink">
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
                  className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
                  role="progressbar"
                  aria-valuenow={Math.round(batch.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-300"
                    style={{ width: `${Math.max(2, Math.round(batch.progress * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="my-5" title="Agent ของสถานบริการ">
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
                  {/* The machine, said the way someone can check it: which PC,
                      on which card, at which address. */}
                  <CellMeta>
                    {[
                      row.hostname,
                      row.ipAddress,
                      row.networkInterface,
                      row.macAddress?.toUpperCase(),
                    ]
                      .filter(Boolean)
                      .join(" · ") || "-"}
                  </CellMeta>
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
              // Every other date on this page is Thai; an ISO string here made
              // the row look like two different calendars side by side.
              render: (row) => (
                <span className="text-xs text-muted">{formatDate(row.lastSyncedVisitDate)}</span>
              ),
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
