import { Download } from "lucide-react";

import { LiveStatusBadge } from "@/components/ui/live-refresh";
import { formatDateTime, relativeTime } from "@/components/ui/primitives";
import { SyncHistoryWorkspace } from "@/components/ui/sync-history-workspace";
import {
  AgentDetailsTable,
  AgentFleetStatusSummary,
  RunningSyncPanel,
  SyncPageHeader,
  SyncSetupCard,
  SyncSetupScrollArea,
  SyncWorkspace,
} from "@/components/ui/sync-workspace";
import {
  canManageFacility,
  canTriggerSync,
  isSuperAdmin,
  requireUser,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import { liveSignature } from "@/lib/shared/live-signature";
import { ROLE_LABELS } from "@/lib/shared/roles";
import { lookupLatestAgentRelease } from "@/lib/services/agent-release";
import {
  getFleetSummary,
  listAgents,
  listRunningBatches,
  listSyncBatches,
} from "@/lib/services/monitoring";

import { AgentTokenForm, SyncNowForm, VerifyDataForm } from "../admin/forms";

export const metadata = { title: "สถานะการซิงก์" };
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const user = await requireUser();
  const scope = resolveFacilityScope(user);
  const canSeeTechnical = user.role !== "USER";

  // USER accounts see only their enrolled machines. Administrative roles see
  // every Agent inside the facility scope they already hold server-side.
  const ownAgentsOnly = user.role === "USER" ? user.userId : null;

  const [agentRows, batches, fleet, running, release] = await Promise.all([
    listAgents(scope.facilityIds, ownAgentsOnly),
    listSyncBatches(scope.facilityIds, 50),
    getFleetSummary(scope.facilityIds),
    listRunningBatches(scope.facilityIds),
    lookupLatestAgentRelease(),
  ]);

  const enrollable = agentRows.filter((agent) => canManageFacility(user, agent.facilityId));
  const triggerAllowed = canTriggerSync(user);

  const agentPresentations = agentRows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    facilityCode: agent.facilityCode,
    facilityName: agent.facilityName,
    hostname: agent.hostname,
    effectiveStatus: agent.effectiveStatus,
    jhcisState: agent.jhcisState,
    pendingBatches: agent.pendingBatches,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    lastSuccessfulSyncAt: agent.lastSuccessfulSyncAt,
    lastSyncedVisitDate: agent.lastSyncedVisitDate,
    lastError: agent.lastError,
    action:
      triggerAllowed && agent.status !== "DISABLED" ? (
        <div className="grid min-w-[178px] gap-1.5 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
          <SyncNowForm agentId={agent.id} />
          <VerifyDataForm agentId={agent.id} />
        </div>
      ) : undefined,
  }));

  const agentSummary = (
    <AgentFleetStatusSummary
      statuses={agentRows.map((agent) => agent.effectiveStatus)}
      online={fleet.online}
      totalAgents={fleet.agentsTotal}
      lastSyncLabel={relativeTime(fleet.lastSyncAt)}
      failedBatches24h={fleet.failedBatches24h}
      facilitiesInScope={isSuperAdmin(user) ? fleet.facilities : 1}
    />
  );

  const historyRows = batches.map((batch) => ({
    id: batch.id,
    batchRef: batch.batchRef,
    facilityCode: batch.facilityCode,
    facilityName: batch.facilityName,
    agentName: batch.agentName,
    mode: batch.mode,
    status: batch.status,
    rangeFrom: batch.rangeFrom,
    rangeTo: batch.rangeTo,
    startedAt: batch.startedAt.toISOString(),
    recordsRead: batch.recordsRead,
    recordsAccepted: batch.recordsAccepted,
    recordsRejected: batch.recordsRejected,
    errorMessage: batch.errorMessage,
  }));

  const installer = (
    <SyncSetupCard
      title="โปรแกรมเชื่อมข้อมูล JHCIS (Agent)"
      description="ติดตั้งบนเครื่องภายในเครือข่ายที่มองเห็น JHCISDB"
      icon="download"
    >
      {release.status === "ok" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] text-slate-700">
              เวอร์ชันล่าสุด <span className="numeric font-bold text-slate-900">{release.release.version}</span>
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted">
              {release.release.fileName} · {(release.release.sizeBytes / 1024 / 1024).toFixed(1)} MB
              {release.release.publishedAt
                ? ` · เผยแพร่ ${formatDateTime(release.release.publishedAt)}`
                : ""}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              ติดตั้งทับเวอร์ชันเดิมได้ โดยคงข้อมูลประจำตัว การตั้งค่า และคิวที่ยังส่งไม่สำเร็จ
            </p>
          </div>
          <a
            href="/download/agent"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-3.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-700"
          >
            <Download aria-hidden className="size-4" />
            ดาวน์โหลดตัวติดตั้ง
          </a>
        </div>
      ) : (
        <p className="text-[12px] leading-relaxed text-muted">
          {release.status === "not-configured"
            ? "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GITHUB_TOKEN จึงดึงไฟล์ติดตั้งมาแสดงไม่ได้"
            : release.status === "none-published"
              ? "ยังไม่มีไฟล์ติดตั้งเผยแพร่ — ผู้ดูแลระบบต้องสร้าง release พร้อมไฟล์ SDCAgent-Setup-x.y.z.exe ก่อน"
              : `ดึงข้อมูลไฟล์ติดตั้งไม่สำเร็จ: ${release.detail}`}
        </p>
      )}
    </SyncSetupCard>
  );

  const enrollment = (
    <SyncSetupCard
      title="เชื่อมต่อโปรแกรมกับระบบ"
      description="ผูกเครื่องกับสถานบริการครั้งเดียวหลังติดตั้ง"
      icon="enroll"
    >
      <ol className="ml-4 list-decimal space-y-1 text-[11.5px] leading-relaxed text-slate-600 marker:text-slate-400">
        <li>เปิด Agent บนเครื่องที่มองเห็น JHCISDB และตั้งค่าการเชื่อมต่อ</li>
        <li>ทดสอบ JHCIS ให้สำเร็จก่อนลงทะเบียนกับศูนย์กลาง</li>
        <li>สร้างรหัสด้านล่าง แล้วนำไปกรอกใน Agent ภายในเวลาที่กำหนด</li>
      </ol>

      <div className="mt-3">
        {enrollable.length ? (
          <SyncSetupScrollArea>
            {enrollable.map((agent) => (
              <div key={agent.id} className="rounded-[9px] border border-slate-200 bg-slate-50/70 p-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
                  <p className="text-[12.5px] font-semibold text-slate-800">{agent.name}</p>
                  <p className="text-[10.5px] text-muted">
                    {agent.facilityCode} · {agent.facilityName}
                  </p>
                </div>
                <AgentTokenForm agentId={agent.id} label="ขอรหัสลงทะเบียน" />
              </div>
            ))}
          </SyncSetupScrollArea>
        ) : (
          <div className="rounded-[9px] bg-slate-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted">
            {agentRows.length ? (
              <p>
                บัญชี <span className="font-medium text-slate-700">{ROLE_LABELS[user.role]}</span>{" "}
                ขอรหัสลงทะเบียนเองไม่ได้ กรุณาติดต่อผู้ดูแลระบบส่วนกลางหรือผู้ดูแลสถานบริการ
              </p>
            ) : (
              <p>สถานบริการของคุณยังไม่มี Agent กรุณาแจ้งผู้ดูแลระบบส่วนกลางให้สร้าง Agent ก่อน</p>
            )}
          </div>
        )}
      </div>
    </SyncSetupCard>
  );

  return (
    <SyncWorkspace
      header={
        <SyncPageHeader
          action={
            <LiveStatusBadge
              initialSignature={liveSignature({
                agents: agentRows.map((agent) => ({ ...agent, status: agent.effectiveStatus })),
                running,
              })}
            />
          }
        />
      }
      monitoring={
        <SyncHistoryWorkspace
          batches={historyRows}
          showFacility={isSuperAdmin(user)}
          showTechnicalError={canSeeTechnical}
          agentSummary={agentSummary}
          runningSync={<RunningSyncPanel batches={running} />}
        />
      }
      agents={<AgentDetailsTable agents={agentPresentations} canSeeTechnical={canSeeTechnical} />}
      setup={
        <div className="grid items-stretch gap-3 xl:grid-cols-2">
          {installer}
          {enrollment}
        </div>
      }
    />
  );
}
